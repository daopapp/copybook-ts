import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, CopybookError } from '../src/copybook.js';
import { decodeRecord, decodeFile, DecodeError } from '../src/decode.js';
import { encodeComp3 } from '../src/comp3.js';
import { encodeEbcdic } from '../src/ebcdic.js';

const CUSTOMER = `
      * Customer master record, sample layout
       01  CUSTOMER.
           05  CUST-ID         PIC 9(5).
           05  CUST-NAME       PIC X(20).
           05  BALANCE         PIC S9(7)V99 COMP-3.
           05  ORDER-COUNT     PIC S9(4) COMP.
           05  STATUS-CODE     PIC S9(3).
`;

test('computes sizes and offsets in the right order', () => {
  const l = parseCopybook(CUSTOMER);
  assert.equal(l.name, 'CUSTOMER');
  assert.deepEqual(
    l.fields.map((f) => [f.item.name, f.item.offset, f.item.size]),
    [
      ['CUST-ID', 0, 5],
      ['CUST-NAME', 5, 20],
      ['BALANCE', 25, 5], // 9 digits -> ceil(10/2) = 5
      ['ORDER-COUNT', 30, 2], // 4 digits in COMP -> 2 bytes
      ['STATUS-CODE', 32, 3], // zone sign, no extra byte
    ],
  );
  assert.equal(l.size, 35);
});

test('a group item is the sum of its children and is not counted twice', () => {
  const l = parseCopybook(`
       01  REC.
           05  HEADER.
               10  KIND      PIC X.
               10  STAMP     PIC 9(8).
           05  BODY.
               10  A         PIC X(10).
               10  B         PIC X(10).
  `);
  assert.equal(l.size, 29, '1 + 8 + 10 + 10');
  assert.equal(l.root.children[0]!.size, 9, 'HEADER');
  assert.equal(l.root.children[1]!.offset, 9, 'BODY starts after HEADER');
  assert.equal(l.fields.length, 4, 'only elementary items are flattened');
});

test('levels 66 and 88 occupy no space', () => {
  const l = parseCopybook(`
       01  REC.
           05  ST            PIC X.
               88  ACTIVE    VALUE 'A'.
               88  INACTIVE  VALUE 'I'.
           05  NAME          PIC X(10).
  `);
  assert.equal(l.size, 11, '88 is not a field');
  assert.equal(l.fields.length, 2);
});

test('ignores comments and the fixed-format sequence area', () => {
  const l = parseCopybook(
    '000100* comment line carrying a sequence number\n' +
      '000200 01  REC.\n' +
      '000300     05  A  PIC X(3).\n',
  );
  assert.equal(l.size, 3);
  assert.equal(l.fields[0]!.item.name, 'A');
});

test('rejects REDEFINES and OCCURS rather than computing a wrong offset', () => {
  // Accepting them unimplemented would produce a layout that decodes without
  // complaint and returns wrong values. Failing loudly is the correct behaviour.
  assert.throws(
    () =>
      parseCopybook(
        '       01  R.\n           05  A PIC X(4).\n           05  B REDEFINES A PIC 9(4).\n',
      ),
    CopybookError,
  );
  assert.throws(
    () =>
      parseCopybook(
        '       01  R.\n           05  N PIC 9(2).\n           05  I OCCURS 1 TO 5 DEPENDING ON N PIC X.\n',
      ),
    CopybookError,
  );
});

test('rejects a malformed copybook', () => {
  assert.throws(() => parseCopybook(''), CopybookError, 'empty');
  assert.throws(() => parseCopybook('       05  A PIC X.\n'), CopybookError, 'does not open at 01');
  assert.throws(
    () => parseCopybook('       01  R.\n           05  G.\n'),
    CopybookError,
    'group with no children',
  );
  assert.throws(
    () => parseCopybook('       01  R.\n           05  A PIC X(3) \n'),
    CopybookError,
    'sentence with no period',
  );
});

// ---------------------------------------------------------------------------
// End to end: build a real EBCDIC record and decode it.
// ---------------------------------------------------------------------------

function customerRecord(
  id: string,
  name: string,
  balance: string,
  orders: number,
  status: number,
) {
  const layout = parseCopybook(CUSTOMER);
  const buf = new Uint8Array(layout.size);

  buf.set(encodeEbcdic(id.padStart(5, '0')), 0);
  buf.set(encodeEbcdic(name.padEnd(20, ' ')), 5);
  buf.set(encodeComp3(balance, 9, 2), 25);

  // COMP: big-endian, two's complement
  new DataView(buf.buffer).setInt16(30, orders, false);

  // Signed DISPLAY: digits carry zone F, the sign rides the last byte's high nibble
  const d = String(Math.abs(status)).padStart(3, '0');
  buf[32] = 0xf0 | Number(d[0]);
  buf[33] = 0xf0 | Number(d[1]);
  buf[34] = (status < 0 ? 0xd0 : 0xc0) | Number(d[2]);

  return { layout, buf };
}

test('decodes an EBCDIC record end to end', () => {
  const { layout, buf } = customerRecord('4711', 'MARIA SILVA', '12345.67', 42, 7);
  const r = decodeRecord(buf, layout, { encoding: 'cp037' });

  assert.equal(r['CUST-ID'], '4711');
  assert.equal(r['CUST-NAME'], 'MARIA SILVA         ');
  assert.equal(r['BALANCE'], '12345.67');
  assert.equal(r['ORDER-COUNT'], '42');
  assert.equal(r['STATUS-CODE'], '7');
});

test('negative values work in COMP-3, COMP and DISPLAY alike', () => {
  const { layout, buf } = customerRecord('1', 'X', '-99.50', -7, -3);
  const r = decodeRecord(buf, layout, { encoding: 'cp037' });
  assert.equal(r['BALANCE'], '-99.50', 'COMP-3 with a D nibble');
  assert.equal(r['ORDER-COUNT'], '-7', "COMP in two's complement");
  assert.equal(r['STATUS-CODE'], '-3', 'DISPLAY with a D sign zone');
});

test('the sign zone is the bug this test exists to pin down', () => {
  // 0xD3 decoded as EBCDIC text yields 'L', not '3'. If anyone rewrites the
  // DISPLAY path to go through a character table, this test breaks.
  const { layout, buf } = customerRecord('1', 'X', '0', 0, -123);
  const r = decodeRecord(buf, layout, { encoding: 'cp037' });
  assert.equal(r['STATUS-CODE'], '-123');
  assert.equal(buf[34], 0xd3, 'last byte carries zone D and digit 3');
});

test('a truncated record fails instead of yielding an empty field', () => {
  const { layout, buf } = customerRecord('1', 'X', '1', 1, 1);
  assert.throws(
    () => decodeRecord(buf.subarray(0, 30), layout, { encoding: 'cp037' }),
    DecodeError,
  );
});

test('a file that is not a multiple of the record size fails on division', () => {
  // The cheapest wrong-layout check there is.
  const { layout, buf } = customerRecord('1', 'X', '1', 1, 1);
  const twoAndAHalf = new Uint8Array(layout.size * 2 + 7);
  twoAndAHalf.set(buf, 0);
  assert.throws(() => [...decodeFile(twoAndAHalf, layout, { encoding: 'cp037' })], DecodeError);
});

test('splits a multi-record file', () => {
  const a = customerRecord('1', 'ANA', '10.00', 1, 1);
  const bb = customerRecord('2', 'BOB', '20.00', 2, 2);
  const file = new Uint8Array(a.buf.length * 2);
  file.set(a.buf, 0);
  file.set(bb.buf, a.buf.length);

  const records = [...decodeFile(file, a.layout, { encoding: 'cp037' })];
  assert.equal(records.length, 2);
  assert.equal(records[0]!['CUST-NAME'], 'ANA                 ');
  assert.equal(records[1]!['BALANCE'], '20.00');
});

test('the RDW shifts by 4 bytes, and ignoring it is the classic error', () => {
  const { layout, buf } = customerRecord('4711', 'MARIA', '1.00', 1, 1);
  const withRdw = new Uint8Array(4 + buf.length);
  new DataView(withRdw.buffer).setUint16(0, withRdw.length, false);
  withRdw.set(buf, 4);

  const correct = decodeRecord(withRdw, layout, { encoding: 'cp037', rdw: true });
  assert.equal(correct['CUST-ID'], '4711');

  // Without handling the RDW the first field comes out wrong or throws. Either
  // is acceptable here. What is not acceptable is returning 4711.
  let result: string | null = null;
  try {
    result = String(decodeRecord(withRdw, layout, { encoding: 'cp037' })['CUST-ID']);
  } catch {
    result = 'threw';
  }
  assert.notEqual(result, '4711', 'ignoring the RDW must not accidentally give the right value');
});
