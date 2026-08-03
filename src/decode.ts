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

/** A table decodes to an array: of values when elementary, of records when a group. */
export type DecodedValue = Value | DecodedRecord | DecodedValue[];

export type DecodedRecord = { [key: string]: DecodedValue };

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

/**
 * Decodes a single elementary field out of a record buffer.
 *
 * @param at byte offset to read from. Defaults to `item.offset`, which is the
 *   right answer only for a layout that is not variable; inside a table, and
 *   after one, the caller knows the real position and passes it.
 */
export function decodeField(
  buf: Uint8Array,
  item: Item,
  options: DecodeOptions,
  at: number = item.offset,
): Value {
  const field = item.field;
  if (!field) throw new DecodeError(`${item.name} is not an elementary field`);

  const slice = buf.subarray(at, at + item.size);
  if (slice.length !== item.size) {
    throw new DecodeError(
      `${item.name}: expected ${item.size} bytes at offset ${at}, ` +
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

export interface ScopeEntry {
  /** Key this entry takes in the decoded record. */
  readonly key: string;
  /** Path from the scope root, which becomes the key when the name collides. */
  readonly path: string;
  readonly item: Item;
}

/**
 * What one level of a decoded record contains: its elementary fields and its
 * tables, in physical order.
 *
 * A table stops the descent, because it becomes an array of its own and its
 * children are named inside each element rather than in this scope. Groups that
 * are not tables are flattened away, which is what keeps a plain record flat.
 *
 * The key is the short name when unique in the scope and the path when it
 * collides, because copybooks reuse the same name across branches often enough
 * to matter. The type generator calls this too: a second copy of the rule would
 * drift, and the symptom would be a type naming a property nobody sets.
 *
 * @param prefix path already consumed. Defaults to the scope's own name, which
 *   is what the record root wants; a table element passes `''` because its
 *   fields are named relative to the element.
 */
// ponytail: quadratic in entries per scope, fine for the dozens a level holds.
export function scopeEntries(scope: Item, prefix: string = scope.name): ScopeEntry[] {
  const found: Array<{ path: string; item: Item }> = [];

  const walk = (item: Item, at: string) => {
    for (const child of item.children) {
      const path = at ? `${at}.${child.name}` : child.name;
      if (child.occurs || child.children.length === 0) found.push({ path, item: child });
      else walk(child, path);
    }
  };
  walk(scope, prefix);

  return found.map(({ path, item }) => ({
    key: found.filter((f) => f.item.name === item.name).length === 1 ? item.name : path,
    path,
    item,
  }));
}

/** The keys of the record's top level. Kept as the name callers already know. */
export function fieldKeys(layout: Layout): Array<{ key: string; item: Item }> {
  return scopeEntries(layout.root);
}

/**
 * Values decoded so far at one level, by field name, so that a
 * `DEPENDING ON` can find its counter.
 *
 * Lookup climbs outward: a nested table may be sized by a field of the record
 * root. It never descends, because a count declared inside the table it sizes
 * is a copybook error, and `parseCopybook` already refuses it.
 */
interface Frame {
  readonly byName: Map<string, Value>;
}

function resolveCount(item: Item, frames: Frame[]): number {
  const occurs = item.occurs!;
  if (!occurs.dependingOn) return occurs.max;

  for (const frame of frames) {
    const raw = frame.byName.get(occurs.dependingOn);
    if (raw === undefined) continue;
    if (raw === null) {
      throw new DecodeError(`${item.name}: ${occurs.dependingOn} decoded to null, so the count is unknown`);
    }
    const count = Number(raw);
    if (!Number.isInteger(count)) {
      throw new DecodeError(`${item.name}: ${occurs.dependingOn} is "${raw}", which is not a whole count`);
    }
    if (count < occurs.min || count > occurs.max) {
      throw new DecodeError(
        `${item.name}: ${occurs.dependingOn} says ${count}, outside OCCURS ${occurs.min} TO ${occurs.max}. ` +
          'Either the record is wrong or the copybook does not match it.',
      );
    }
    return count;
  }

  throw new DecodeError(
    `${item.name}: OCCURS DEPENDING ON ${occurs.dependingOn}, which was not decoded before the table`,
  );
}

/**
 * Decodes one level of the record, advancing a cursor.
 *
 * The cursor is the whole reason this is a walk and not a set of lookups by
 * `item.offset`: a table with `DEPENDING ON` changes its own length per record,
 * so everything after it moves. Precomputed offsets would be right for the
 * first record and quietly wrong for the next one.
 */
function decodeScope(
  buf: Uint8Array,
  scope: Item,
  prefix: string,
  from: number,
  options: DecodeOptions,
  outer: Frame[],
): { record: DecodedRecord; cursor: number } {
  const record: DecodedRecord = {};
  const frame: Frame = { byName: new Map() };
  const frames = [frame, ...outer];
  let cursor = from;

  for (const { key, item } of scopeEntries(scope, prefix)) {
    if (!item.occurs) {
      const value = decodeField(buf, item, options, cursor);
      record[key] = value;
      frame.byName.set(item.name, value);
      cursor += item.size;
      continue;
    }

    const count = resolveCount(item, frames);
    const values: DecodedValue[] = [];
    for (let i = 0; i < count; i += 1) {
      if (item.children.length === 0) {
        values.push(decodeField(buf, item, options, cursor));
        cursor += item.size;
      } else {
        const element = decodeScope(buf, item, '', cursor, options, frames);
        values.push(element.record);
        cursor = element.cursor;
      }
    }
    record[key] = values;
  }

  return { record, cursor };
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
  return readRecord(buf, layout, options).record;
}

/** Same as `decodeRecord`, plus how many bytes the record actually took. */
function readRecord(
  buf: Uint8Array,
  layout: Layout,
  options: DecodeOptions,
): { record: DecodedRecord; cursor: number } {
  const body = options.rdw ? buf.subarray(4) : buf;

  // A fixed layout knows its length up front, so check it before reading a
  // single field: the error then names the layout instead of a field. A variable
  // layout cannot, and a truncated one surfaces at the field that runs out.
  if (!layout.variable && body.length < layout.size) {
    throw new DecodeError(
      `record is ${body.length} bytes, layout ${layout.name} requires ${layout.size}`,
    );
  }

  return decodeScope(body, layout.root, layout.root.name, 0, options, []);
}

/**
 * Splits a record file and decodes each record.
 *
 * Three ways to find where a record ends, in order of how much they can
 * validate:
 *
 * 1. A Record Descriptor Word carries the length, so it is read and trusted.
 * 2. A fixed layout divides the file. That division is the cheapest
 *    wrong-layout check there is: a remainder means the copybook does not match
 *    the data, caught before looking at a single value.
 * 3. A variable layout without an RDW has to be walked, resolving each
 *    `DEPENDING ON` to learn the length of the record in hand. Nothing
 *    validates the total, so a wrong copybook shows up as a field error
 *    somewhere in the middle instead of a clean failure up front.
 */
export function* decodeFile(
  buf: Uint8Array,
  layout: Layout,
  options: DecodeOptions,
): Generator<DecodedRecord> {
  if (options.rdw) {
    let at = 0;
    while (at < buf.length) {
      if (at + 4 > buf.length) {
        throw new DecodeError(`${buf.length - at} trailing bytes, too few for a Record Descriptor Word`);
      }
      // The RDW length counts its own four bytes.
      const length = (buf[at]! << 8) | buf[at + 1]!;
      if (length < 4 || at + length > buf.length) {
        throw new DecodeError(
          `the RDW at byte ${at} says ${length} bytes, which does not fit the remaining ${buf.length - at}`,
        );
      }
      yield decodeRecord(buf.subarray(at, at + length), layout, options);
      at += length;
    }
    return;
  }

  if (!layout.variable) {
    if (buf.length % layout.size !== 0) {
      throw new DecodeError(
        `file is ${buf.length} bytes, which is not a multiple of ${layout.size}. ` +
          'Either the copybook does not match the data, or the RDW is unhandled.',
      );
    }
    for (let at = 0; at < buf.length; at += layout.size) {
      yield decodeRecord(buf.subarray(at, at + layout.size), layout, options);
    }
    return;
  }

  let at = 0;
  while (at < buf.length) {
    const { record, cursor } = readRecord(buf.subarray(at), layout, options);
    if (cursor === 0) throw new DecodeError(`layout ${layout.name} consumed no bytes, so the walk cannot advance`);
    yield record;
    at += cursor;
  }
}
