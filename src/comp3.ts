/**
 * COMP-3, packed decimal.
 *
 * Two digits per byte, and the final nibble carries the sign. Reading it as a
 * binary integer returns a wrong number rather than an error, which is why this
 * module fails loudly on an invalid nibble instead of normalising it away.
 */

export class Comp3Error extends Error {}

/** Sign nibbles accepted when reading. Some compilers emit A, B and E. */
const POSITIVE_SIGNS = new Set([0xa, 0xc, 0xe, 0xf]);
const NEGATIVE_SIGNS = new Set([0xb, 0xd]);

/**
 * Decodes COMP-3 into a decimal string.
 *
 * Returns a string rather than a number on purpose: `PIC S9(16)V99` exceeds
 * `Number.MAX_SAFE_INTEGER`, and converting to a double would silently lose
 * cents. The caller decides between BigInt, a decimal library, or accepting the
 * loss.
 *
 * @param buf the field bytes, exactly the field length
 * @param scale decimal places, meaning whatever follows the `V` in the PIC
 */
export function decodeComp3(buf: Uint8Array, scale = 0): string {
  if (buf.length === 0) throw new Comp3Error('empty COMP-3 field');
  if (scale < 0) throw new Comp3Error(`negative scale: ${scale}`);

  const nibbles: number[] = [];
  for (const byte of buf) {
    nibbles.push((byte >> 4) & 0xf, byte & 0xf);
  }

  const sign = nibbles.pop()!;
  let negative: boolean;
  if (NEGATIVE_SIGNS.has(sign)) negative = true;
  else if (POSITIVE_SIGNS.has(sign)) negative = false;
  else {
    // A sign nibble outside the valid set almost always means the field offset
    // is wrong, not that the data is exotic.
    throw new Comp3Error(
      `invalid sign nibble 0x${sign.toString(16).toUpperCase()}: ` +
        'the field offset is probably wrong',
    );
  }

  let digits = '';
  for (const n of nibbles) {
    if (n > 9) {
      throw new Comp3Error(
        `invalid data nibble 0x${n.toString(16).toUpperCase()}: ` +
          'the field offset is probably wrong',
      );
    }
    digits += String(n);
  }

  if (scale > digits.length) {
    throw new Comp3Error(`scale ${scale} exceeds the ${digits.length} digits in the field`);
  }

  const whole = (scale ? digits.slice(0, digits.length - scale) : digits) || '0';
  const fraction = scale ? digits.slice(digits.length - scale) : '';
  const trimmed = whole.replace(/^0+(?=\d)/, '');
  const body = fraction ? `${trimmed}.${fraction}` : trimmed;

  // Negative zero exists in COMP-3 and means zero. Emitting "-0.00" would be
  // technically faithful and practically a bug for anyone comparing strings.
  const isZero = /^0(\.0*)?$/.test(body);
  return negative && !isZero ? `-${body}` : body;
}

/**
 * Encodes a decimal string into COMP-3.
 *
 * Writing emits only C, D or F. Being lenient when reading and strict when
 * writing avoids propagating one compiler's quirks into your data.
 */
export function encodeComp3(
  value: string,
  digits: number,
  scale = 0,
  options: { signed?: boolean } = {},
): Uint8Array {
  const signed = options.signed ?? true;

  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (!m[2] && !m[3])) throw new Comp3Error(`invalid decimal value: "${value}"`);

  const negative = m[1] === '-';
  const whole = m[2] ?? '';
  const fraction = m[3] ?? '';

  if (fraction.length > scale) {
    throw new Comp3Error(
      `"${value}" has ${fraction.length} decimal places, the field accepts ${scale}`,
    );
  }

  const all = whole + fraction.padEnd(scale, '0');
  const trimmed = all.replace(/^0+(?=\d)/, '') || '0';
  if (trimmed.length > digits) {
    throw new Comp3Error(`"${value}" needs ${trimmed.length} digits, the field holds ${digits}`);
  }
  if (negative && !signed) {
    throw new Comp3Error(`negative value in an unsigned field: "${value}"`);
  }

  const nib = (
    trimmed.padStart(digits, '0') + (signed ? (negative ? 'D' : 'C') : 'F')
  ).split('');
  if (nib.length % 2) nib.unshift('0');

  const out = new Uint8Array(nib.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (parseInt(nib[i * 2]!, 16) << 4) | parseInt(nib[i * 2 + 1]!, 16);
  }
  return out;
}
