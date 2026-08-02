/**
 * COBOL copybook into a layout tree with byte offsets.
 *
 * The order of work matters:
 *   1. build the level tree, computing nothing
 *   2. compute sizes bottom up
 *   3. compute offsets top down
 *
 * Swapping steps 2 and 3 produces wrong offsets for every group item, because a
 * group's size is the sum of its children.
 */

import { parsePic, type PictureField } from './pic.js';

export class CopybookError extends Error {}

export interface Item {
  readonly level: number;
  readonly name: string;
  /** Present only on elementary items. A group item has no PIC. */
  readonly field?: PictureField | undefined;
  readonly children: Item[];
  /** Byte offset from the start of the record. */
  offset: number;
  size: number;
}

export interface Layout {
  readonly name: string;
  readonly size: number;
  readonly root: Item;
  /** Every elementary item, flattened, in physical order. */
  readonly fields: ReadonlyArray<{ path: string; item: Item }>;
}

/**
 * Levels that occupy no bytes:
 *   66 = RENAMES, an alias over an existing range
 *   88 = condition name (VALUE), not a field
 * Counting them inflates the record size.
 */
const ZERO_WIDTH_LEVELS = new Set([66, 88]);

interface Sentence {
  readonly text: string;
  readonly line: number;
}

/**
 * Splits the copybook into period-terminated sentences.
 *
 * Handles the sequence area (columns 1 to 6) and the comment indicator in
 * column 7, both of which appear in copybooks exported straight off a mainframe.
 */
function sentences(source: string): Sentence[] {
  const out: Sentence[] = [];
  let acc = '';
  let start = 0;

  source.split(/\r?\n/).forEach((rawLine, idx) => {
    let line = rawLine;

    // Fixed format: 1 to 6 sequence, 7 indicator, 8 to 72 code. Only strip when
    // column 7 really is an indicator, otherwise a free-format copybook would
    // lose the first seven characters of its names.
    if (line.length > 7 && /^[\d ]{6}[*\-/ ]/.test(line)) {
      const indicator = line[6];
      if (indicator === '*' || indicator === '/') return; // comment line
      line = line.slice(7, 72);
    }

    const text = line.replace(/^\s*\*.*$/, '').trim();
    if (!text) return;

    if (!acc) start = idx + 1;
    acc += (acc ? ' ' : '') + text;

    if (acc.endsWith('.')) {
      out.push({ text: acc.slice(0, -1).trim(), line: start });
      acc = '';
    }
  });

  if (acc.trim()) {
    throw new CopybookError(`sentence with no terminating period, starting at line ${start}`);
  }
  return out;
}

interface Declaration {
  level: number;
  name: string;
  pic?: string | undefined;
  usage?: string | undefined;
  sign?: string | undefined;
  line: number;
}

function declare(s: Sentence): Declaration | null {
  const m = /^(\d{2})\s+(\S+)(.*)$/.exec(s.text);
  if (!m) throw new CopybookError(`line ${s.line}: could not parse "${s.text}"`);

  const level = Number(m[1]);
  const name = m[2]!.toUpperCase();
  const rest = m[3] ?? '';

  if (ZERO_WIDTH_LEVELS.has(level)) return null;

  // Failing loudly is deliberate. REDEFINES and OCCURS change how offsets are
  // computed; accepting them unimplemented would produce a wrong layout that
  // decodes without complaint, which is the worst possible outcome here.
  if (/\bREDEFINES\b/i.test(rest)) {
    throw new CopybookError(
      `line ${s.line}: REDEFINES is not supported yet. ` +
        'It is a union over the same memory and requires choosing an interpretation ' +
        'that the copybook itself does not record.',
    );
  }
  if (/\bOCCURS\b/i.test(rest)) {
    throw new CopybookError(
      `line ${s.line}: OCCURS is not supported yet. ` +
        'With DEPENDING ON the record is variable length, so the layout has to be ' +
        'resolved per record rather than once per copybook.',
    );
  }

  const pic = /\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i.exec(rest)?.[1];
  const usage =
    /\b(?:USAGE\s+(?:IS\s+)?)?(COMP(?:UTATIONAL)?(?:-[12345])?|PACKED-DECIMAL|BINARY|DISPLAY)\b/i.exec(
      rest,
    )?.[1];
  const sign =
    /\bSIGN\s+(?:IS\s+)?((?:LEADING|TRAILING)(?:\s+SEPARATE(?:\s+CHARACTER)?)?)/i.exec(rest)?.[1];

  return { level, name, pic, usage, sign, line: s.line };
}

/** Step 1: the level tree, with no sizes and no offsets yet. */
function buildTree(decls: Declaration[]): Item {
  if (!decls.length) throw new CopybookError('copybook contains no declarations');

  const rootDecl = decls[0]!;
  if (rootDecl.level !== 1 && rootDecl.level !== 77) {
    throw new CopybookError(
      `line ${rootDecl.line}: expected level 01 or 77 to open the copybook, found ` +
        String(rootDecl.level).padStart(2, '0'),
    );
  }

  const make = (d: Declaration): Item => ({
    level: d.level,
    name: d.name,
    field: d.pic ? parsePic(d.pic, { usage: d.usage, sign: d.sign }) : undefined,
    children: [],
    offset: 0,
    size: 0,
  });

  const root = make(rootDecl);
  const stack: Item[] = [root];

  for (const d of decls.slice(1)) {
    while (stack.length > 1 && d.level <= stack[stack.length - 1]!.level) stack.pop();
    const parent = stack[stack.length - 1]!;
    if (d.level <= parent.level) {
      throw new CopybookError(`line ${d.line}: level ${d.level} does not nest under ${parent.name}`);
    }
    const item = make(d);
    parent.children.push(item);
    stack.push(item);
  }
  return root;
}

/** Step 2: sizes bottom up. A group is the sum of its children. */
function computeSizes(item: Item): number {
  if (item.children.length === 0) {
    if (!item.field) {
      throw new CopybookError(`${item.name} has neither a PIC nor children, so it has no size`);
    }
    item.size = item.field.size;
    return item.size;
  }
  if (item.field) {
    throw new CopybookError(`${item.name} has both a PIC and children`);
  }
  item.size = item.children.reduce((sum, c) => sum + computeSizes(c), 0);
  return item.size;
}

/** Step 3: offsets top down. */
function computeOffsets(item: Item, base: number): void {
  item.offset = base;
  let cursor = base;
  for (const c of item.children) {
    computeOffsets(c, cursor);
    cursor += c.size;
  }
}

function flatten(item: Item, prefix: string, out: Array<{ path: string; item: Item }>): void {
  const path = prefix ? `${prefix}.${item.name}` : item.name;
  if (item.children.length === 0) out.push({ path, item });
  else for (const c of item.children) flatten(c, path, out);
}

/**
 * Wraps an item tree that already carries sizes and offsets into a layout.
 *
 * Generated modules use this to rebuild the layout from a frozen tree, so the
 * flattening rule lives in one place instead of being duplicated by the code
 * generator.
 */
export function layoutFrom(root: Item): Layout {
  const fields: Array<{ path: string; item: Item }> = [];
  flatten(root, '', fields);
  return { name: root.name, size: root.size, root, fields };
}

/** Parses a copybook and returns the layout with sizes and offsets resolved. */
export function parseCopybook(source: string): Layout {
  const decls = sentences(source)
    .map(declare)
    .filter((d): d is Declaration => d !== null);

  const root = buildTree(decls);
  computeSizes(root);
  computeOffsets(root, 0);

  return layoutFrom(root);
}
