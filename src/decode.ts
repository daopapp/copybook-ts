/**
 * Record decoding, driven by a parsed layout.
 *
 * One rule the whole module respects: never convert the record to text before
 * slicing it. COMP-3 and BINARY fields are binary, they have no encoding, and
 * running them through a character table destroys the value.
 */

import { decodeComp3 } from './comp3.js';
import { decodeEbcdic } from './ebcdic.js';
import type { Item, Layout } from './copybook.js';

export class DecodeError extends Error {}

export type Encoding = 'cp037' | 'ascii';

export interface DecodeOptions {
  /** Encoding for text and display fields. Required by choice, never defaulted. */
  encoding: Encoding;
  /**
   * Whether each record carries a 4-byte Record Descriptor Word (`RECFM=VB`).
   * Ignoring the RDW shifts everything by 4 bytes, and the symptom is the first
   * field coming out consistently wrong.
   */
  rdw?: boolean | undefined;
}

/** Decimal values come back as strings so large fields keep their precision. */
export type Value = string | number | null;

export type DecodedRecord = Record<string, Value>;

function text(buf: Uint8Array, enc: Encoding): string {
  if (enc === 'cp037') return decodeEbcdic(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return s;
}

/**
 * Zoned decimal, meaning a numeric DISPLAY field.
 *
 * The digit is always the low nibble, which holds in EBCDIC (`0xF1`) and in
 * ASCII (`0x31`) alike. That is why this path needs no character table, and why
 * it works for both encodings without branching.
 *
 * When the field is signed, the sign lives in the high nibble of the last byte:
 * `C` positive, `D` negative, `F` unsigned.
 */
function zonedDecimal(buf: Uint8Array, item: Item): string {
  const field = item.field!;
  let body = buf;
  let separateNegative: boolean | null = null;

  if (field.signed && field.signPosition.startsWith('separate')) {
    const leading = field.signPosition === 'separate-leading';
    const signByte = leading ? buf[0]! : buf[buf.length - 1]!;
    const asEbcdic = text(Uint8Array.of(signByte), 'cp037');
    const asAscii = String.fromCharCode(signByte);
    if (asEbcdic === '-' || asAscii === '-') separateNegative = true;
    else if (asEbcdic === '+' || asAscii === '+') separateNegative = false;
    else {
      throw new DecodeError(
        `${item.name}: invalid separate sign byte 0x${signByte.toString(16)}`,
      );
    }
    body = leading ? buf.slice(1) : buf.slice(0, -1);
  }

  let digits = '';
  let negative = separateNegative ?? false;

  for (let i = 0; i < body.length; i += 1) {
    const b = body[i]!;
    const low = b & 0x0f;
    if (low > 9) {
      throw new DecodeError(
        `${item.name}: invalid digit nibble 0x${low.toString(16)} at position ${i}: ` +
          'the field offset is probably wrong',
      );
    }
    digits += String(low);

    const isLast = i === body.length - 1;
    const isFirst = i === 0;
    const carriesSign =
      field.signed &&
      separateNegative === null &&
      ((field.signPosition === 'trailing' && isLast) ||
        (field.signPosition === 'leading' && isFirst));

    if (carriesSign) {
      const high = (b >> 4) & 0x0f;
      if (high === 0xd || high === 0xb) negative = true;
      else if (high === 0xc || high === 0xa || high === 0xe || high === 0xf) negative = false;
      else if (high === 0x3) negative = false; // ASCII digits carry zone 0x3
      else {
        throw new DecodeError(
          `${item.name}: invalid sign zone 0x${high.toString(16)} at byte ${i}`,
        );
      }
    }
  }

  const scale = field.scale;
  if (scale > digits.length) {
    throw new DecodeError(`${item.name}: scale ${scale} exceeds ${digits.length} digits`);
  }
  const whole = (scale ? digits.slice(0, digits.length - scale) : digits) || '0';
  const fraction = scale ? digits.slice(digits.length - scale) : '';
  const trimmed = whole.replace(/^0+(?=\d)/, '');
  const body2 = fraction ? `${trimmed}.${fraction}` : trimmed;
  const isZero = /^0(\.0*)?$/.test(body2);
  return negative && !isZero ? `-${body2}` : body2;
}

/** BINARY (COMP) is a big-endian integer in two's complement. */
function binary(buf: Uint8Array, item: Item): string {
  const field = item.field!;
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);

  if (field.signed) {
    const bits = BigInt(buf.length * 8);
    const limit = 1n << (bits - 1n);
    if (v >= limit) v -= 1n << bits;
  }

  if (field.scale === 0) return v.toString();
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(field.scale + 1, '0');
  const cut = abs.length - field.scale;
  return `${neg ? '-' : ''}${abs.slice(0, cut)}.${abs.slice(cut)}`;
}

/** Decodes a single elementary field out of a record buffer. */
export function decodeField(buf: Uint8Array, item: Item, options: DecodeOptions): Value {
  const field = item.field;
  if (!field) throw new DecodeError(`${item.name} is not an elementary field`);

  const slice = buf.subarray(item.offset, item.offset + item.size);
  if (slice.length !== item.size) {
    throw new DecodeError(
      `${item.name}: expected ${item.size} bytes at offset ${item.offset}, ` +
        `only ${slice.length} available: truncated record`,
    );
  }

  if (field.category === 'alphanumeric') return text(slice, options.encoding);

  switch (field.usage) {
    case 'DISPLAY':
      return zonedDecimal(slice, item);
    case 'COMP-3':
      try {
        return decodeComp3(slice, field.scale);
      } catch (e) {
        throw new DecodeError(`${item.name}: ${(e as Error).message}`);
      }
    case 'BINARY':
      return binary(slice, item);
    case 'COMP-1':
      return new DataView(slice.buffer, slice.byteOffset, 4).getFloat32(0, false);
    case 'COMP-2':
      return new DataView(slice.buffer, slice.byteOffset, 8).getFloat64(0, false);
  }
}

/**
 * The key each field takes in a decoded record: short name when unique, full
 * path when it collides. Copybooks reuse the same name across different
 * branches often enough to matter.
 *
 * Exported because the type generator has to produce exactly these keys. A
 * second copy of the rule would drift, and the symptom would be a type that
 * names a property the decoder never sets.
 */
// ponytail: quadratic in field count, fine for the hundreds of fields a
// copybook holds. Group by name if a record ever has thousands.
export function fieldKeys(layout: Layout): Array<{ key: string; item: Item }> {
  return layout.fields.map(({ path, item }) => ({
    key: layout.fields.filter((f) => f.item.name === item.name).length === 1 ? item.name : path,
    item,
  }));
}

/**
 * Decodes one complete record.
 *
 * @param buf bytes of exactly one record
 */
export function decodeRecord(
  buf: Uint8Array,
  layout: Layout,
  options: DecodeOptions,
): DecodedRecord {
  const body = options.rdw ? buf.subarray(4) : buf;
  if (body.length < layout.size) {
    throw new DecodeError(
      `record is ${body.length} bytes, layout ${layout.name} requires ${layout.size}`,
    );
  }

  const out: DecodedRecord = {};
  for (const { key, item } of fieldKeys(layout)) {
    out[key] = decodeField(body, item, options);
  }
  return out;
}

/**
 * Splits a fixed-length record file and decodes each record.
 *
 * The division is the cheapest wrong-layout check that exists: if the file is
 * not a multiple of the record size, the copybook does not match the data.
 */
export function* decodeFile(
  buf: Uint8Array,
  layout: Layout,
  options: DecodeOptions,
): Generator<DecodedRecord> {
  const step = layout.size + (options.rdw ? 4 : 0);
  if (buf.length % step !== 0) {
    throw new DecodeError(
      `file is ${buf.length} bytes, which is not a multiple of ${step}. ` +
        'Either the copybook does not match the data, or the RDW is unhandled.',
    );
  }
  for (let i = 0; i < buf.length; i += step) {
    yield decodeRecord(buf.subarray(i, i + step), layout, options);
  }
}
