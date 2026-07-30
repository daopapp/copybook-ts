/**
 * COBOL PICTURE clause interpretation.
 *
 * The central point: a PIC clause does not describe a value, it describes how
 * many bytes a field occupies and how to read them. Getting the size wrong does
 * not raise, it shifts every field that follows in the record.
 */

/** How the field is physically stored. */
export type Usage =
  | 'DISPLAY' // one byte per digit or character
  | 'COMP-3' // packed decimal, two digits per byte
  | 'BINARY' // big-endian integer
  | 'COMP-1' // 4-byte float
  | 'COMP-2'; // 8-byte float

export type Category = 'alphanumeric' | 'numeric';

/** Where the sign lives, for a signed DISPLAY field. */
export type SignPosition = 'trailing' | 'leading' | 'separate-trailing' | 'separate-leading';

export interface PictureField {
  readonly pic: string;
  readonly category: Category;
  readonly usage: Usage;
  /** Total digit count, including those after the implied decimal point. */
  readonly digits: number;
  /** Digits after the `V`. `PIC 9(5)V99` has a scale of 2. */
  readonly scale: number;
  readonly signed: boolean;
  readonly signPosition: SignPosition;
  readonly size: number;
}

export class PicError extends Error {}

/**
 * Expands PIC repetition notation.
 *
 * `9(3)` becomes `999`, `XX` stays `XX`. Both forms coexist in one clause, so
 * `S9(3)V9(2)` is equivalent to `S999V99`.
 */
function expand(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (body[i + 1] !== '(') {
      out += ch;
      i += 1;
      continue;
    }
    const close = body.indexOf(')', i + 2);
    if (close === -1) throw new PicError(`unclosed parenthesis in "${body}"`);
    const raw = body.slice(i + 2, close);
    if (!/^\d+$/.test(raw)) throw new PicError(`invalid repetition "${raw}" in "${body}"`);
    const n = Number(raw);
    if (n < 1) throw new PicError(`repetition must be greater than zero in "${body}"`);
    out += ch.repeat(n);
    i = close + 1;
  }
  return out;
}

/** Byte size of a BINARY (COMP) integer, by the standard COBOL digit bands. */
function binarySize(digits: number): number {
  if (digits <= 4) return 2;
  if (digits <= 9) return 4;
  if (digits <= 18) return 8;
  throw new PicError(`BINARY with ${digits} digits exceeds the 18 digit limit`);
}

/** Byte size of a COMP-3 field. The `+1` is the sign nibble. */
export function comp3Size(digits: number): number {
  return Math.ceil((digits + 1) / 2);
}

function normaliseUsage(raw: string | undefined): Usage {
  if (!raw) return 'DISPLAY';
  switch (raw.toUpperCase().replace(/\s+/g, ' ').trim()) {
    case 'DISPLAY':
      return 'DISPLAY';
    case 'COMP-3':
    case 'COMPUTATIONAL-3':
    case 'PACKED-DECIMAL':
      return 'COMP-3';
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
    case 'COMPUTATIONAL':
    case 'COMPUTATIONAL-4':
    case 'BINARY':
      return 'BINARY';
    case 'COMP-1':
    case 'COMPUTATIONAL-1':
      return 'COMP-1';
    case 'COMP-2':
    case 'COMPUTATIONAL-2':
      return 'COMP-2';
    default:
      throw new PicError(`unknown USAGE: "${raw}"`);
  }
}

export interface PicOptions {
  usage?: string | undefined;
  /** SIGN clause when present: "LEADING", "TRAILING SEPARATE" and so on. */
  sign?: string | undefined;
}

/**
 * Interprets a PIC clause and returns the field descriptor.
 *
 * @param pic the PIC body, without the `PIC` keyword. For example `S9(5)V99`.
 */
export function parsePic(pic: string, options: PicOptions = {}): PictureField {
  const raw = pic.trim().replace(/\.$/, '');
  if (!raw) throw new PicError('empty PIC');

  const usage = normaliseUsage(options.usage);
  const body = expand(raw.toUpperCase());

  const signed = body.startsWith('S');
  const unsignedBody = signed ? body.slice(1) : body;

  if (unsignedBody.includes('S')) throw new PicError(`S may only lead the clause: "${pic}"`);

  const isAlpha = /[XA]/.test(unsignedBody);
  const isNumeric = /[9VPZ]/.test(unsignedBody);

  if (isAlpha && isNumeric) throw new PicError(`PIC mixes alphanumeric and numeric: "${pic}"`);

  if (isAlpha) {
    if (signed) throw new PicError(`S does not apply to an alphanumeric PIC: "${pic}"`);
    if (usage !== 'DISPLAY') {
      throw new PicError(`USAGE ${usage} does not apply to an alphanumeric PIC: "${pic}"`);
    }
    return {
      pic: raw,
      category: 'alphanumeric',
      usage,
      digits: 0,
      scale: 0,
      signed: false,
      signPosition: 'trailing',
      size: unsignedBody.length,
    };
  }

  if (!isNumeric) throw new PicError(`PIC contains no recognised symbol: "${pic}"`);

  if ((unsignedBody.match(/V/g) ?? []).length > 1) {
    throw new PicError(`more than one V in "${pic}"`);
  }

  const vIndex = unsignedBody.indexOf('V');
  const digits = (unsignedBody.match(/9/g) ?? []).length;
  if (digits === 0) throw new PicError(`numeric PIC with no 9 at all: "${pic}"`);
  const scale = vIndex === -1 ? 0 : (unsignedBody.slice(vIndex + 1).match(/9/g) ?? []).length;

  const sign = (options.sign ?? '').toUpperCase();
  const separate = sign.includes('SEPARATE');
  const leading = sign.includes('LEADING');
  const signPosition: SignPosition = separate
    ? leading
      ? 'separate-leading'
      : 'separate-trailing'
    : leading
      ? 'leading'
      : 'trailing';

  if (sign && !signed) throw new PicError(`SIGN clause without S in the PIC: "${pic}"`);
  if (sign && usage !== 'DISPLAY') {
    throw new PicError(`SIGN clause only applies to DISPLAY, not ${usage}: "${pic}"`);
  }

  let size: number;
  switch (usage) {
    case 'DISPLAY':
      // A sign carried in the zone nibble costs no byte. SIGN SEPARATE costs
      // one extra byte, and that is the exception which shifts the whole
      // record when it is missed.
      size = digits + (signed && separate ? 1 : 0);
      break;
    case 'COMP-3':
      size = comp3Size(digits);
      break;
    case 'BINARY':
      size = binarySize(digits);
      break;
    case 'COMP-1':
      size = 4;
      break;
    case 'COMP-2':
      size = 8;
      break;
  }

  return { pic: raw, category: 'numeric', usage, digits, scale, signed, signPosition, size };
}
