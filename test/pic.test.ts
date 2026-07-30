import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePic, comp3Size, PicError } from '../src/pic.js';

test('expands repetition and counts digits', () => {
  assert.equal(parsePic('9(5)').size, 5);
  assert.equal(parsePic('99999').size, 5);
  assert.equal(parsePic('X(30)').size, 30);
  // Both notations coexist inside one clause
  assert.deepEqual(
    { d: parsePic('S9(3)V9(2)').digits, s: parsePic('S9(3)V9(2)').scale },
    { d: 5, s: 2 },
  );
  assert.deepEqual({ d: parsePic('S999V99').digits, s: parsePic('S999V99').scale }, { d: 5, s: 2 });
});

test('V costs no byte, it marks the decimal position', () => {
  const f = parsePic('9(5)V99');
  assert.equal(f.size, 7, 'seven digits, seven bytes in display');
  assert.equal(f.scale, 2);
  assert.equal(f.digits, 7);
});

test('S costs no byte when the sign rides in the zone nibble', () => {
  assert.equal(parsePic('S9(3)').size, 3, 'a zone sign spends no byte');
  assert.equal(parsePic('9(3)').size, 3);
  assert.equal(parsePic('S9(3)').signed, true);
  assert.equal(parsePic('9(3)').signed, false);
});

test('SIGN SEPARATE costs one extra byte', () => {
  const zone = parsePic('S9(3)');
  const separate = parsePic('S9(3)', { sign: 'TRAILING SEPARATE' });
  assert.equal(zone.size, 3);
  assert.equal(separate.size, 4, 'here the sign byte is physical');
  assert.equal(separate.signPosition, 'separate-trailing');
  assert.equal(parsePic('S9(3)', { sign: 'LEADING' }).signPosition, 'leading');
});

test('COMP-3 size follows ceil((digits + 1) / 2)', () => {
  // Vectors checked against the formula in the standard
  assert.equal(comp3Size(1), 1);
  assert.equal(comp3Size(3), 2);
  assert.equal(comp3Size(7), 4);
  assert.equal(comp3Size(11), 6);
  assert.equal(parsePic('S9(5)V99', { usage: 'COMP-3' }).size, 4);
  assert.equal(parsePic('S9(9)V99', { usage: 'PACKED-DECIMAL' }).size, 6);
});

test('BINARY sizes by digit band, not by digit count', () => {
  assert.equal(parsePic('S9(4)', { usage: 'COMP' }).size, 2);
  assert.equal(parsePic('S9(5)', { usage: 'BINARY' }).size, 4);
  assert.equal(parsePic('S9(9)', { usage: 'COMP-4' }).size, 4);
  assert.equal(parsePic('S9(10)', { usage: 'COMP' }).size, 8);
  assert.equal(parsePic('S9(4)', { usage: 'COMP-1' }).size, 4);
  assert.equal(parsePic('S9(4)', { usage: 'COMP-2' }).size, 8);
});

test('rejects an invalid PIC instead of guessing', () => {
  assert.throws(() => parsePic(''), PicError);
  assert.throws(() => parsePic('9(0)'), PicError, 'zero repetition');
  assert.throws(() => parsePic('9(3'), PicError, 'unclosed parenthesis');
  assert.throws(() => parsePic('X(3)9(2)'), PicError, 'mixes alphanumeric with numeric');
  assert.throws(() => parsePic('9V9V9'), PicError, 'two V symbols');
  assert.throws(() => parsePic('SX(3)'), PicError, 'S on an alphanumeric field');
  assert.throws(() => parsePic('VVV'), PicError, 'numeric with no 9');
  assert.throws(() => parsePic('X(3)', { usage: 'COMP-3' }), PicError, 'COMP-3 on text');
  assert.throws(() => parsePic('9(3)', { sign: 'LEADING' }), PicError, 'SIGN without S');
  assert.throws(() => parsePic('9(19)', { usage: 'COMP' }), PicError, 'beyond 18 digits');
  assert.throws(() => parsePic('9(3)', { usage: 'COMP-9' }), PicError, 'nonexistent USAGE');
});
