import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateModule } from '../src/codegen.js';
import { CopybookError } from '../src/copybook.js';
import { encodeComp3 } from '../src/comp3.js';
import {
  CUSTOMER_MASTER_LAYOUT,
  decodeCustomerMaster,
  decodeCustomerMasterFile,
} from './fixtures/customer.generated.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

const COPYBOOK = readFileSync(fixture('customer.cpy'), 'utf8');

test('the committed fixture matches a fresh run of the generator', () => {
  const fresh = generateModule(COPYBOOK, {
    importFrom: '../../src/index.js',
    sourceName: 'customer.cpy',
  });
  assert.equal(
    fresh,
    readFileSync(fixture('customer.generated.ts'), 'utf8'),
    'regenerate with: npm run codegen:fixture',
  );
});

test('float usages type as number, everything else as string', () => {
  const out = generateModule(COPYBOOK);
  assert.match(out, /^ {2}RATE: number;$/m); // COMP-1
  assert.match(out, /^ {2}BALANCE: string;$/m); // COMP-3, would lose cents as a double
  assert.match(out, /^ {2}'ORDER-COUNT': string;$/m); // BINARY
  assert.match(out, /^ {2}'CUST-NAME': string;$/m);
});

test('a duplicated field name types under its full path, exactly as decodeRecord keys it', () => {
  const out = generateModule(COPYBOOK);
  assert.match(out, /^ {2}'CUSTOMER-MASTER\.BILLING\.ADDRESS-LINE': string;$/m);
  assert.match(out, /^ {2}'CUSTOMER-MASTER\.SHIPPING\.ADDRESS-LINE': string;$/m);
  assert.doesNotMatch(out, /^ {2}'?ADDRESS-LINE'?:/m);
});

/**
 * The check that matters: the generated properties are the keys the decoder
 * really sets. A type that names a property nobody writes is worse than no
 * type at all, because it type-checks.
 */
test('the generated interface names exactly the keys the decoder produces', () => {
  const declared = [
    ...generateModule(COPYBOOK).matchAll(/^ {2}'?([^':]+)'?: (?:string|number);$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(Object.keys(decodeCustomerMaster(record(), { encoding: 'ascii' })), declared);
});

function record(): Uint8Array {
  const buf = new Uint8Array(CUSTOMER_MASTER_LAYOUT.size);
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i += 1) buf[at + i] = s.charCodeAt(i);
  };
  ascii('00042', 0);
  ascii('MARIA SILVA         ', 5);
  buf.set(encodeComp3('12345.67', 9, 2), 25);
  new DataView(buf.buffer).setInt16(30, 7, false);
  new DataView(buf.buffer).setFloat32(32, 1.5, false);
  ascii('RUA A 100 ', 36);
  ascii('RUA B 200 ', 46);
  return buf;
}

test('the frozen layout decodes the same values the parsed one would', () => {
  const decoded = decodeCustomerMaster(record(), { encoding: 'ascii' });
  assert.equal(decoded['CUST-ID'], '42');
  assert.equal(decoded['CUST-NAME'], 'MARIA SILVA         ');
  assert.equal(decoded.BALANCE, '12345.67');
  assert.equal(decoded['ORDER-COUNT'], '7');
  assert.equal(decoded.RATE, 1.5);
  assert.equal(decoded['CUSTOMER-MASTER.BILLING.ADDRESS-LINE'], 'RUA A 100 ');
  assert.equal(decoded['CUSTOMER-MASTER.SHIPPING.ADDRESS-LINE'], 'RUA B 200 ');
});

test('the file decoder walks every record', () => {
  const one = record();
  const two = new Uint8Array(one.length * 2);
  two.set(one, 0);
  two.set(one, one.length);
  const all = [...decodeCustomerMasterFile(two, { encoding: 'ascii' })];
  assert.equal(all.length, 2);
  assert.equal(all[1]!.BALANCE, '12345.67');
});

test('a copybook the parser refuses never reaches generation', () => {
  assert.throws(
    () => generateModule('       01  REC.\n           05  ITEMS OCCURS 5 TIMES PIC X(3).\n'),
    CopybookError,
  );
});

test('a name opening with a digit still yields a valid identifier', () => {
  const out = generateModule('       01  1ST-REC.\n           05  A PIC X.\n');
  assert.match(out, /export interface Record1stRec \{/);
  assert.match(out, /export const RECORD_1ST_REC_LAYOUT: Layout/);
});
