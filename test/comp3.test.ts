import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeComp3, encodeComp3, Comp3Error } from '../src/comp3.js';

const b = (...n: number[]) => Uint8Array.of(...n);
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join(' ');

test('decodes the canonical PIC S9(5)V99 COMP-3 vectors', () => {
  assert.equal(decodeComp3(b(0x12, 0x34, 0x56, 0x7c), 2), '12345.67');
  assert.equal(decodeComp3(b(0x12, 0x34, 0x56, 0x7d), 2), '-12345.67');
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x0c), 2), '0.00');
  assert.equal(decodeComp3(b(0x99, 0x99, 0x99, 0x9c), 2), '99999.99');
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x1d), 2), '-0.01');
});

test('a zero scale yields an integer', () => {
  assert.equal(decodeComp3(b(0x12, 0x3f)), '123');
  assert.equal(decodeComp3(b(0x7d)), '-7');
});

test('negative zero is zero, not "-0"', () => {
  // It exists in COMP-3 and it is a zero. Emitting "-0.00" would break anyone
  // comparing strings.
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x0d), 2), '0.00');
  assert.equal(decodeComp3(b(0x0d)), '0');
});

test('accepts A, B and E as sign nibbles when reading', () => {
  // Some compilers emit these. Rejecting them would refuse valid data.
  assert.equal(decodeComp3(b(0x12, 0x3a)), '123', 'A is positive');
  assert.equal(decodeComp3(b(0x12, 0x3e)), '123', 'E is positive');
  assert.equal(decodeComp3(b(0x12, 0x3b)), '-123', 'B is negative');
  assert.equal(decodeComp3(b(0x12, 0x3f)), '123', 'F is unsigned');
});

test('fails loudly on an invalid nibble rather than returning a wrong number', () => {
  // This is the point of the module: an odd nibble almost always means a wrong
  // offset, and normalising it silently propagates the error record-wide.
  assert.throws(() => decodeComp3(b(0x12, 0x30)), Comp3Error, 'sign 0 does not exist');
  assert.throws(() => decodeComp3(b(0x12, 0x39)), Comp3Error, 'sign 9 does not exist');
  assert.throws(() => decodeComp3(b(0x1a, 0x2c)), Comp3Error, 'data nibble A');
  assert.throws(() => decodeComp3(b()), Comp3Error, 'empty field');
  assert.throws(() => decodeComp3(b(0x1c), 5), Comp3Error, 'scale beyond the digit count');
});

test('encodes to exactly the expected bytes', () => {
  assert.equal(hex(encodeComp3('12345.67', 7, 2)), '12 34 56 7c');
  assert.equal(hex(encodeComp3('-12345.67', 7, 2)), '12 34 56 7d');
  assert.equal(hex(encodeComp3('0', 7, 2)), '00 00 00 0c');
  assert.equal(hex(encodeComp3('123', 3, 0, { signed: false })), '12 3f');
  assert.equal(hex(encodeComp3('123456789.01', 11, 2)), '12 34 56 78 90 1c');
});

test('writing emits only C, D or F', () => {
  // Lenient reading, strict writing: no compiler quirk gets propagated.
  const sign = (u: Uint8Array) => u[u.length - 1]! & 0x0f;
  assert.equal(sign(encodeComp3('1', 3, 0)), 0xc);
  assert.equal(sign(encodeComp3('-1', 3, 0)), 0xd);
  assert.equal(sign(encodeComp3('1', 3, 0, { signed: false })), 0xf);
});

test('encoding rejects what does not fit', () => {
  assert.throws(() => encodeComp3('123456', 3, 0), Comp3Error, 'more digits than the field');
  assert.throws(() => encodeComp3('1.234', 7, 2), Comp3Error, 'more decimals than the scale');
  assert.throws(() => encodeComp3('-1', 3, 0, { signed: false }), Comp3Error, 'negative unsigned');
  assert.throws(() => encodeComp3('abc', 3, 0), Comp3Error, 'not a decimal');
  assert.throws(() => encodeComp3('', 3, 0), Comp3Error, 'empty');
});

test('round trip preserves the value', () => {
  for (const v of ['0.00', '1.00', '-1.00', '12345.67', '-12345.67', '99999.99', '-0.01']) {
    assert.equal(decodeComp3(encodeComp3(v, 7, 2), 2), v, `value ${v}`);
  }
});

test('a large field keeps full precision', () => {
  // PIC S9(16)V99 exceeds Number.MAX_SAFE_INTEGER. That is why the API returns
  // a string instead of a number.
  const large = '9007199254740993.99';
  assert.equal(decodeComp3(encodeComp3(large, 18, 2), 2), large);
  assert.notEqual(String(Number(large)), large, 'confirms a double would lose it');
});
