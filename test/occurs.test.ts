import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, CopybookError, totalSize } from '../src/copybook.js';
import { decodeRecord, decodeFile, DecodeError } from '../src/decode.js';
import { encodeComp3 } from '../src/comp3.js';
import { decodeOrderRecord, decodeOrderRecordFile, ORDER_RECORD_LAYOUT } from './fixtures/order.generated.js';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function bytes(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? ascii(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

test('a fixed table of an elementary item sizes as count times one occurrence', () => {
  const layout = parseCopybook(`
       01  REC.
           05  KIND   PIC X.
           05  CODES  PIC X(2) OCCURS 3 TIMES.
           05  TAIL   PIC X.
`);
  const codes = layout.fields.find((f) => f.item.name === 'CODES')!.item;
  assert.equal(codes.size, 2, 'size is one occurrence');
  assert.equal(totalSize(codes), 6, 'the whole table is count times that');
  assert.equal(layout.size, 8);
  assert.equal(layout.variable, false);

  // The tail is what catches a table sized as one occurrence: it would land on
  // the wrong byte and decode to something that still looks like data.
  const decoded = decodeRecord(bytes('A', 'XXYYZZ', 'B'), layout, { encoding: 'ascii' });
  assert.deepEqual(decoded, { KIND: 'A', CODES: ['XX', 'YY', 'ZZ'], TAIL: 'B' });
});

test('a fixed table of a group decodes to an array of records', () => {
  const layout = parseCopybook(`
       01  REC.
           05  PAIRS OCCURS 2 TIMES.
               10  LEFT   PIC X.
               10  RIGHT  PIC 9.
`);
  assert.equal(layout.size, 4);
  assert.deepEqual(decodeRecord(bytes('A1B2'), layout, { encoding: 'ascii' }), {
    PAIRS: [
      { LEFT: 'A', RIGHT: '1' },
      { LEFT: 'B', RIGHT: '2' },
    ],
  });
});

const ORDER = `
       01  ORDER-RECORD.
           05  ORDER-ID    PIC 9(5).
           05  LINE-COUNT  PIC 9(2).
           05  LINES OCCURS 1 TO 3 TIMES DEPENDING ON LINE-COUNT.
               10  ITEM-CODE PIC X(3).
               10  QTY       PIC S9(3) COMP-3.
           05  TOTAL       PIC S9(5)V99 COMP-3.
`;

/** One order, with as many lines as asked for. */
function order(id: string, lines: Array<[string, string]>, total: string): Uint8Array {
  return bytes(
    id,
    String(lines.length).padStart(2, '0'),
    ...lines.flatMap(([code, qty]) => [code, encodeComp3(qty, 3)]),
    encodeComp3(total, 7, 2),
  );
}

test('DEPENDING ON reads the count from the record, and the size is the maximum', () => {
  const layout = parseCopybook(ORDER);
  assert.equal(layout.variable, true);
  assert.equal(layout.size, 5 + 2 + 3 * 5 + 4, 'maximum: three lines');
});

test('the field after a variable table moves with the count', () => {
  const layout = parseCopybook(ORDER);

  const one = decodeRecord(order('00042', [['ABC', '10']], '99.50'), layout, { encoding: 'ascii' });
  assert.deepEqual(one, {
    'ORDER-ID': '42',
    'LINE-COUNT': '1',
    LINES: [{ 'ITEM-CODE': 'ABC', QTY: '10' }],
    TOTAL: '99.50',
  });

  // Same layout, longer record. TOTAL sits five bytes later, and reading it at
  // the offset computed for the previous record is exactly the bug the walk
  // exists to avoid.
  const two = decodeRecord(
    order('00043', [['ABC', '10'], ['DEF', '-5']], '12345.67'),
    layout,
    { encoding: 'ascii' },
  );
  assert.equal(two.TOTAL, '12345.67');
  assert.deepEqual(two.LINES, [
    { 'ITEM-CODE': 'ABC', QTY: '10' },
    { 'ITEM-CODE': 'DEF', QTY: '-5' },
  ]);
});

test('a count outside the OCCURS range fails instead of reading past the record', () => {
  const layout = parseCopybook(ORDER);
  const buf = order('00042', [['ABC', '10']], '1.00');
  buf.set(ascii('09'), 5); // says nine lines, the copybook allows three

  assert.throws(() => decodeRecord(buf, layout, { encoding: 'ascii' }), {
    name: 'Error',
    message: /says 9, outside OCCURS 1 TO 3/,
  });
});

test('a table nested in a table resolves per element', () => {
  const layout = parseCopybook(`
       01  REC.
           05  GROUPS OCCURS 2 TIMES.
               10  TAG    PIC X.
               10  ITEMS  PIC 9 OCCURS 2 TIMES.
`);
  assert.equal(layout.size, 6);
  assert.deepEqual(decodeRecord(bytes('A12B34'), layout, { encoding: 'ascii' }), {
    GROUPS: [
      { TAG: 'A', ITEMS: ['1', '2'] },
      { TAG: 'B', ITEMS: ['3', '4'] },
    ],
  });
});

test('a variable file is walked record by record, not divided', () => {
  const layout = parseCopybook(ORDER);
  const file = bytes(
    order('00001', [['AAA', '1']], '1.00'),
    order('00002', [['BBB', '2'], ['CCC', '3'], ['DDD', '4']], '2.00'),
    order('00003', [['EEE', '5'], ['FFF', '6']], '3.00'),
  );

  const ids = [...decodeFile(file, layout, { encoding: 'ascii' })].map((r) => r['ORDER-ID']);
  assert.deepEqual(ids, ['1', '2', '3']);
});

test('with an RDW the length comes from the record, so records may differ in size', () => {
  const layout = parseCopybook(ORDER);
  const withRdw = (body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint16(0, out.length, false);
    out.set(body, 4);
    return out;
  };
  const file = bytes(
    withRdw(order('00001', [['AAA', '1']], '1.00')),
    withRdw(order('00002', [['BBB', '2'], ['CCC', '3']], '2.00')),
  );

  const all = [...decodeFile(file, layout, { encoding: 'ascii', rdw: true })];
  assert.deepEqual(all.map((r) => r['ORDER-ID']), ['1', '2']);
  assert.equal((all[1]!.LINES as unknown[]).length, 2);
});

test('an RDW that does not fit the remaining bytes fails', () => {
  const layout = parseCopybook(ORDER);
  const body = order('00001', [['AAA', '1']], '1.00');
  const buf = new Uint8Array(4 + body.length);
  new DataView(buf.buffer).setUint16(0, 999, false);
  buf.set(body, 4);

  assert.throws(() => [...decodeFile(buf, layout, { encoding: 'ascii', rdw: true })], DecodeError);
});

test('the copybook is refused when the count cannot be read before the table', () => {
  const after = `
       01  REC.
           05  LINES OCCURS 1 TO 2 TIMES DEPENDING ON N.
               10  A PIC X.
           05  N     PIC 9.
`;
  assert.throws(() => parseCopybook(after), {
    name: 'Error',
    message: /declared after the table/,
  });

  const inside = `
       01  REC.
           05  N     PIC 9.
           05  LINES OCCURS 1 TO 2 TIMES DEPENDING ON M.
               10  M PIC 9.
`;
  assert.throws(() => parseCopybook(inside), { message: /inside the table it sizes/ });

  const missing = `
       01  REC.
           05  LINES OCCURS 1 TO 2 TIMES DEPENDING ON NOPE.
               10  A PIC X.
`;
  assert.throws(() => parseCopybook(missing), { message: /no field named NOPE exists/ });

  const text = `
       01  REC.
           05  N     PIC X.
           05  LINES OCCURS 1 TO 2 TIMES DEPENDING ON N.
               10  A PIC X.
`;
  assert.throws(() => parseCopybook(text), { message: /not a numeric field/ });
});

test('OCCURS clauses that describe access, not layout, are ignored', () => {
  const layout = parseCopybook(`
       01  REC.
           05  CODES PIC X OCCURS 3 TIMES INDEXED BY I.
`);
  assert.equal(layout.size, 3);
});

test('the generated module decodes a variable record end to end', () => {
  assert.equal(ORDER_RECORD_LAYOUT.variable, true);

  const decoded = decodeOrderRecord(order('00042', [['ABC', '10'], ['DEF', '20']], '55.25'), {
    encoding: 'ascii',
  });
  // The generated type is what is being checked here: these read without a cast.
  assert.equal(decoded.LINES[1]!['ITEM-CODE'], 'DEF');
  assert.equal(decoded.TOTAL, '55.25');

  const file = bytes(
    order('00001', [['AAA', '1']], '1.00'),
    order('00002', [['BBB', '2'], ['CCC', '3']], '2.00'),
  );
  const all = [...decodeOrderRecordFile(file, { encoding: 'ascii' })];
  assert.deepEqual(all.map((r) => r.LINES.length), [1, 2]);
});

test('REDEFINES is still refused', () => {
  assert.throws(
    () =>
      parseCopybook(`
       01  REC.
           05  A PIC X(4).
           05  B REDEFINES A PIC 9(4).
`),
    CopybookError,
  );
});
