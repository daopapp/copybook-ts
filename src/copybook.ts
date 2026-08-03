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

/**
 * An `OCCURS` clause, meaning the item is a table.
 *
 * `min` and `max` are equal for a fixed table. They differ only with
 * `DEPENDING ON`, where the actual count lives in another field of the same
 * record and is known only when that record is read.
 */
export interface Occurs {
  readonly min: number;
  readonly max: number;
  /** Name of the field holding the count, for `OCCURS DEPENDING ON`. */
  readonly dependingOn?: string | undefined;
}

export interface Item {
  readonly level: number;
  readonly name: string;
  /** Present only on elementary items. A group item has no PIC. */
  readonly field?: PictureField | undefined;
  /** Present only on a table. */
  readonly occurs?: Occurs | undefined;
  readonly children: Item[];
  /**
   * Byte offset from the start of the record, exact only when the layout is
   * not `variable`. On a table this is the offset of the first occurrence.
   *
   * The decoder never reads this: it walks the tree with a cursor, because with
   * `DEPENDING ON` every offset after the table moves per record. The field is
   * kept because it is what a person reading a layout wants to see.
   */
  offset: number;
  /**
   * Bytes of a **single** occurrence. The whole table is this times the count,
   * which is what `totalSize` returns.
   */
  size: number;
}

/** Bytes an item occupies in the record, counting every occurrence. */
export function totalSize(item: Item): number {
  return item.size * (item.occurs ? item.occurs.max : 1);
}

export interface Layout {
  readonly name: string;
  /** Record size in bytes. The **maximum** when `variable` is true. */
  readonly size: number;
  /**
   * True when some table has `DEPENDING ON`, so the record length varies and
   * a file of these records cannot be split by division.
   */
  readonly variable: boolean;
  readonly root: Item;
  /**
   * Every elementary item, flattened, in physical order. One entry per
   * declaration, not per occurrence: a table of 10 appears once.
   */
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
  occurs?: Occurs | undefined;
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
  const occurs = parseOccurs(rest, s.line);

  const pic = /\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i.exec(rest)?.[1];
  const usage =
    /\b(?:USAGE\s+(?:IS\s+)?)?(COMP(?:UTATIONAL)?(?:-[12345])?|PACKED-DECIMAL|BINARY|DISPLAY)\b/i.exec(
      rest,
    )?.[1];
  const sign =
    /\bSIGN\s+(?:IS\s+)?((?:LEADING|TRAILING)(?:\s+SEPARATE(?:\s+CHARACTER)?)?)/i.exec(rest)?.[1];

  return { level, name, pic, usage, sign, occurs, line: s.line };
}

/**
 * Reads the `OCCURS` clause.
 *
 * Accepts `OCCURS 5`, `OCCURS 5 TIMES`, `OCCURS 1 TO 5 TIMES DEPENDING ON N`
 * and the form without `TO`, which some copybooks use even for `DEPENDING ON`.
 * Trailing clauses such as `INDEXED BY` and `ASCENDING KEY` are ignored: they
 * describe access, not layout, so they cost no bytes.
 */
function parseOccurs(rest: string, line: number): Occurs | undefined {
  if (!/\bOCCURS\b/i.test(rest)) return undefined;

  const m = /\bOCCURS\s+(?:(\d+)\s+TO\s+)?(\d+)\b(?:\s+TIMES\b)?/i.exec(rest);
  if (!m) throw new CopybookError(`line ${line}: could not read the OCCURS clause in "${rest.trim()}"`);

  const max = Number(m[2]);
  if (max < 1) throw new CopybookError(`line ${line}: OCCURS ${max} is not a table`);

  const dependingOn = /\bDEPENDING\s+(?:ON\s+)?([A-Za-z0-9-]+)/i.exec(rest)?.[1]?.toUpperCase();
  // Without DEPENDING ON the table is fixed, so min and max coincide. The
  // "n TO m" form without DEPENDING ON is still fixed at m in practice: nothing
  // in the record says otherwise.
  const min = dependingOn ? Number(m[1] ?? 0) : max;

  if (min > max) throw new CopybookError(`line ${line}: OCCURS ${min} TO ${max} has min above max`);

  return dependingOn ? { min, max, dependingOn } : { min, max };
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
    occurs: d.occurs,
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

/**
 * Step 2: sizes bottom up. A group is the sum of its children.
 *
 * `item.size` holds one occurrence and the return value holds the whole table,
 * which is what a parent has to add up. Conflating the two is how a table of
 * ten ends up sized as one and shifts every field after it.
 */
function computeSizes(item: Item): number {
  if (item.children.length === 0) {
    if (!item.field) {
      throw new CopybookError(`${item.name} has neither a PIC nor children, so it has no size`);
    }
    item.size = item.field.size;
    return totalSize(item);
  }
  if (item.field) {
    throw new CopybookError(`${item.name} has both a PIC and children`);
  }
  item.size = item.children.reduce((sum, c) => sum + computeSizes(c), 0);
  return totalSize(item);
}

/** Step 3: offsets top down. Inside a table these describe occurrence one. */
function computeOffsets(item: Item, base: number): void {
  item.offset = base;
  let cursor = base;
  for (const c of item.children) {
    computeOffsets(c, cursor);
    cursor += totalSize(c);
  }
}

function anyDependingOn(item: Item): boolean {
  return Boolean(item.occurs?.dependingOn) || item.children.some(anyDependingOn);
}

/**
 * Checks that every `DEPENDING ON` names a numeric field declared before the
 * table and outside it.
 *
 * COBOL requires this and so does any decoder: the count has to be readable
 * before the table it sizes. Catching it here turns a copybook mistake into a
 * parse error instead of a record that decodes to the wrong length.
 */
function validateDependingOn(fields: ReadonlyArray<{ path: string; item: Item }>, root: Item): void {
  const tables: Array<{ path: string; item: Item }> = [];
  const walk = (item: Item, prefix: string) => {
    const path = prefix ? `${prefix}.${item.name}` : item.name;
    if (item.occurs?.dependingOn) tables.push({ path, item });
    for (const c of item.children) walk(c, path);
  };
  walk(root, '');

  for (const { path, item } of tables) {
    const name = item.occurs!.dependingOn!;
    const counter = fields.find((f) => f.item.name === name);
    if (!counter) {
      throw new CopybookError(
        `${item.name}: OCCURS DEPENDING ON ${name}, but no field named ${name} exists`,
      );
    }
    if (counter.item.field?.category !== 'numeric') {
      throw new CopybookError(
        `${item.name}: OCCURS DEPENDING ON ${name}, which is not a numeric field`,
      );
    }
    if (counter.path.startsWith(`${path}.`)) {
      throw new CopybookError(
        `${item.name}: OCCURS DEPENDING ON ${name}, which is inside the table it sizes`,
      );
    }
    const first = fields.findIndex((f) => f.path.startsWith(`${path}.`) || f.path === path);
    const at = fields.indexOf(counter);
    if (first !== -1 && at > first) {
      throw new CopybookError(
        `${item.name}: OCCURS DEPENDING ON ${name}, which is declared after the table. ` +
          'The count has to be readable before the table it sizes.',
      );
    }
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
  return { name: root.name, size: totalSize(root), variable: anyDependingOn(root), root, fields };
}

/** Parses a copybook and returns the layout with sizes and offsets resolved. */
export function parseCopybook(source: string): Layout {
  const decls = sentences(source)
    .map(declare)
    .filter((d): d is Declaration => d !== null);

  const root = buildTree(decls);
  computeSizes(root);
  computeOffsets(root, 0);

  const layout = layoutFrom(root);
  validateDependingOn(layout.fields, root);
  return layout;
}
