/**
 * TypeScript source generation from a copybook.
 *
 * The generated module freezes the resolved layout, so the `.cpy` file is a
 * build input and never has to ship. A copybook that stopped parsing then
 * breaks the build, instead of breaking at 3am against a file that arrived
 * overnight.
 *
 * The generated property types are the point. `decodeRecord` returns
 * `string | number | null` for everything, which forces a cast at every call
 * site; here each field carries the type its PIC clause actually produces.
 */

import { parseCopybook, type Item, type Occurs } from './copybook.js';
import { scopeEntries } from './decode.js';
import type { PictureField } from './pic.js';

export interface GenerateOptions {
  /** Module specifier the generated code imports the runtime from. */
  importFrom?: string | undefined;
  /** Copybook file name, for the header comment. */
  sourceName?: string | undefined;
}

/** A single-quoted TypeScript string literal. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** COBOL names carry hyphens, which are not valid unquoted property keys. */
function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : q(name);
}

function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/** `CUSTOMER-MASTER` becomes `CustomerMaster`. */
function pascal(name: string): string {
  const joined = words(name)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  // A COBOL data name may open with a digit, a TypeScript identifier may not.
  return /^[A-Za-z]/.test(joined) ? joined : `Record${joined}`;
}

/** `CUSTOMER-MASTER` becomes `CUSTOMER_MASTER`. */
function screaming(name: string): string {
  const joined = words(name).join('_').toUpperCase();
  return /^[A-Za-z]/.test(joined) ? joined : `RECORD_${joined}`;
}

/**
 * The TypeScript type a field decodes to.
 *
 * Only the two float usages produce a `number`. Everything else comes back as
 * a string, because `PIC S9(16)V99` exceeds `Number.MAX_SAFE_INTEGER` and a
 * double would drop cents with no warning.
 */
function tsType(field: PictureField): string {
  return field.usage === 'COMP-1' || field.usage === 'COMP-2' ? 'number' : 'string';
}

/**
 * The body of an interface, one line per field, recursing into tables.
 *
 * A table of an elementary item becomes `string[]`; a table of a group becomes
 * an inline object array, which keeps the element type next to the only place
 * it is used and sidesteps naming two nested groups that share a name.
 */
function properties(scope: Item, prefix: string, indent: string): string {
  return scopeEntries(scope, prefix)
    .map(({ key, item }) => {
      const name = `${indent}${propertyKey(key)}: `;
      if (item.children.length === 0) {
        const type = tsType(item.field!);
        return `${name}${item.occurs ? `${type}[]` : type};`;
      }
      // A group only reaches here as a table: scopeEntries flattens the rest.
      const inner = properties(item, '', `${indent}  `);
      return `${name}{\n${inner}\n${indent}}[];`;
    })
    .join('\n');
}

function occursLiteral(o: Occurs): string {
  const depending = o.dependingOn ? `, dependingOn: ${q(o.dependingOn)}` : '';
  return `{ min: ${o.min}, max: ${o.max}${depending} }`;
}

function fieldLiteral(f: PictureField): string {
  return (
    `{ pic: ${q(f.pic)}, category: ${q(f.category)}, usage: ${q(f.usage)}, ` +
    `digits: ${f.digits}, scale: ${f.scale}, signed: ${f.signed}, ` +
    `signPosition: ${q(f.signPosition)}, size: ${f.size} }`
  );
}

function itemLiteral(item: Item, indent: string): string {
  const pad = `${indent}  `;
  const lines = [`${pad}level: ${item.level},`, `${pad}name: ${q(item.name)},`];
  if (item.field) lines.push(`${pad}field: ${fieldLiteral(item.field)},`);
  if (item.occurs) lines.push(`${pad}occurs: ${occursLiteral(item.occurs)},`);
  lines.push(`${pad}offset: ${item.offset},`, `${pad}size: ${item.size},`);
  lines.push(
    item.children.length === 0
      ? `${pad}children: [],`
      : `${pad}children: [\n` +
          item.children.map((c) => itemLiteral(c, `${pad}  `)).join(',\n') +
          `,\n${pad}],`,
  );
  return `${indent}{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * Generates a TypeScript module for one copybook.
 *
 * @param source copybook text
 * @returns the module source, ready to write to a `.ts` file
 */
export function generateModule(source: string, options: GenerateOptions = {}): string {
  const layout = parseCopybook(source);
  const from = options.importFrom ?? 'copybook-ts';
  const name = pascal(layout.name);
  const constant = `${screaming(layout.name)}_LAYOUT`;
  const origin = options.sourceName ? ` from ${options.sourceName}` : '';

  const body = properties(layout.root, layout.root.name, '  ');
  const size = layout.variable
    ? `/** Up to ${layout.size} bytes per record: the tables vary in length. */`
    : `/** ${layout.size} bytes per record. */`;

  return `// Generated by copybook-ts${origin}. Do not edit: change the copybook and
// regenerate. The layout below is frozen at build time, so the copybook is not
// needed at runtime.

import { layoutFrom, decodeRecord, decodeFile } from ${q(from)};
import type { DecodeOptions, Item, Layout } from ${q(from)};

export interface ${name} {
${body}
}

const root: Item = ${itemLiteral(layout.root, '')};

${size}
export const ${constant}: Layout = layoutFrom(root);

/** Decodes exactly one record. */
export function decode${name}(buf: Uint8Array, options: DecodeOptions): ${name} {
  return decodeRecord(buf, ${constant}, options) as unknown as ${name};
}

/** Decodes every record in the file. */
export function* decode${name}File(
  buf: Uint8Array,
  options: DecodeOptions,
): Generator<${name}> {
  for (const record of decodeFile(buf, ${constant}, options)) {
    yield record as unknown as ${name};
  }
}
`;
}
