# copybook-ts

Parse COBOL copybooks and decode mainframe fixed-width records in TypeScript.
Packed decimal, EBCDIC, implied decimal points and zone signs are treated as the
rule, not as special cases.

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why this exists

Mainframe data does not fail with an exception. It fails with a number that is
quietly different. `PIC S9(5)V99` read as an integer returns `1234567` instead of
`12345.67`, and nothing complains. A field with the wrong size shifts every
field after it, and the whole record decodes wrong from that point on.

The libraries on npm solve pieces: EBCDIC character conversion, or a parser for
one specific layout. None of them go from copybook to typed value while handling
the cases that actually turn up in bank and insurer files.

## Install

```
npm install copybook-ts
```

Node 20 or newer. No runtime dependencies.

## Usage

```ts
import { parseCopybook, decodeFile } from 'copybook-ts';
import { readFileSync } from 'node:fs';

const layout = parseCopybook(readFileSync('CUSTOMER.cpy', 'utf8'));
console.log(layout.size); // 35

for (const record of decodeFile(readFileSync('CUSTOMER.DAT'), layout, { encoding: 'cp037' })) {
  console.log(record);
  // { 'CUST-ID': '4711', 'CUST-NAME': 'MARIA SILVA         ',
  //   BALANCE: '12345.67', 'ORDER-COUNT': '42', 'STATUS-CODE': '7' }
}
```

Numeric fields come back as **strings**, not numbers. `PIC S9(16)V99` exceeds
`Number.MAX_SAFE_INTEGER`, and converting to a double would drop cents without
warning. The caller decides between `BigInt`, a decimal library, or accepting the
loss.

## Typed records from a copybook

The decoder returns `string | number | null` for every field, which forces a
cast at each call site. The generator resolves the layout once, at build time,
and writes a module where each field carries the type its PIC clause actually
produces.

```
npx copybook-types CUSTOMER.cpy > src/generated/customer.ts
```

```ts
import { decodeCustomerFile } from './generated/customer.js';

for (const record of decodeCustomerFile(bytes, { encoding: 'cp037' })) {
  record['CUST-ID'];  // string
  record.RATE;        // number, because COMP-1 is a float
  record.BLANCE;      // compile error
}
```

Field names stay exactly as the copybook spells them, hyphens included, and
match the keys the decoder sets: short name when unique, full path when the
name repeats across branches. There is no rename table to fall out of sync.

The layout is frozen into the generated file, so the `.cpy` is a build input
and does not ship. A copybook that stops parsing breaks the build instead of
breaking overnight against a file that just arrived.

## What is handled

| Feature | Status |
|---|---|
| `PIC X`, `PIC 9`, with and without `(n)` | yes |
| Implied decimal point (`V`) | yes |
| Zone sign (`S`), trailing and leading | yes |
| `SIGN SEPARATE`, which costs one extra byte | yes |
| `COMP-3` / `PACKED-DECIMAL` | yes, decode and encode |
| `COMP` / `COMP-4` / `BINARY`, big-endian two's complement | yes |
| `COMP-1` and `COMP-2` floats | yes |
| Group items, sized as the sum of their children | yes |
| Levels 66 and 88, which occupy no space | yes |
| Fixed-format sequence area and comment indicator | yes |
| EBCDIC code page 037 | yes |
| Record Descriptor Word (`RECFM=VB`) | yes, via `{ rdw: true }`, one length per record |
| `OCCURS n TIMES`, elementary and group | yes, decodes to an array |
| `OCCURS DEPENDING ON`, resolved per record | yes |
| Tables nested in tables | yes |
| `REDEFINES` | **refuses with an error** |
| EBCDIC code pages other than 037 | no |

`REDEFINES` **fails loudly on purpose**. It is a union over the same memory and
requires choosing an interpretation the copybook does not record. Accepting it
unimplemented would produce a layout that decodes without complaint and returns
wrong values, which is the worst possible outcome for a library like this one.

## Tables

A table decodes to an array. An elementary `OCCURS` gives an array of values, a
group `OCCURS` an array of records:

```
       01  ORDER-RECORD.
           05  ORDER-ID    PIC 9(5).
           05  LINE-COUNT  PIC 9(2).
           05  LINES OCCURS 1 TO 3 TIMES DEPENDING ON LINE-COUNT.
               10  ITEM-CODE PIC X(3).
               10  QTY       PIC S9(3) COMP-3.
           05  TOTAL       PIC S9(5)V99 COMP-3.
```

```ts
{
  'ORDER-ID': '42',
  'LINE-COUNT': '2',
  LINES: [
    { 'ITEM-CODE': 'ABC', QTY: '10' },
    { 'ITEM-CODE': 'DEF', QTY: '-5' },
  ],
  TOTAL: '55.25',
}
```

With `DEPENDING ON` the record length varies, so `layout.variable` is true and
`layout.size` is the **maximum**. The decoder walks the layout with a cursor
instead of reading precomputed offsets: `TOTAL` above sits five bytes later when
a third line arrives, and an offset computed once would be right for the first
record and quietly wrong for the next.

That also decides how a file is split. With an RDW the length comes from each
record. Without one, a fixed layout divides the file, which is the cheapest
wrong-layout check available, and a variable layout has to be walked record by
record, resolving each count to learn where the next record starts.

A count outside the declared `OCCURS` range is an error, not a clamp. So is a
`DEPENDING ON` field declared after the table it sizes, or inside it, which
`parseCopybook` refuses before any data is read.

## Decisions worth explaining

**Lenient when reading, strict when writing.** Sign nibbles `A` and `E` are
accepted as positive and `B` as negative, because some compilers emit them.
Writing only ever emits `C`, `D` and `F`, so one compiler's quirk does not
propagate into your data.

**An invalid nibble is an error, not exotic data.** A sign nibble outside
`A B C D E F`, or a data nibble above 9, almost always means the field offset is
wrong. Normalising it silently hides the error and spreads it across the record.

**Numeric display fields never touch a character table.** The digit is the low
nibble of the byte, which holds identically in EBCDIC (`0xF1`) and ASCII
(`0x31`). Converting the byte to text before extracting the digit is the classic
bug: `0xD3`, which is digit 3 carrying a negative sign, becomes the letter `L`.
There is a test that pins exactly this.

**Dividing the file is the cheapest validation available.** If a fixed-length
file is not a multiple of the record size, the copybook does not match the data,
and that is caught before looking at a single value. A variable layout gives up
that check, which is a reason to prefer an RDW when the file has one.

**The EBCDIC table is generated, not transcribed.** `src/ebcdic.ts` comes from
Python's `cp037` codec, with self-checks on the points that matter (`0xF0` is
`0`, there is a gap between `i` and `j`). Two hundred and fifty six hand-written
bytes age badly and nobody verifies them.

```
npm run ebcdic    # regenerates src/ebcdic.ts
```

CI diffs the committed table against a fresh run of the generator, so editing it
by hand shows up as a failure rather than as silently wrong data.

## Development

```
npm test          # compiles and runs 53 tests on Node's built-in runner
npm run typecheck
```

`test/fixtures/customer.generated.ts` and `order.generated.ts` are committed
generated output, one fixed layout and one variable. Tests regenerate both and
diff, so a change in the generator that nobody meant shows up as a failure, and
`tsc` compiles them along with the suite, so generated code that does not build
fails the build. Regenerate with `npm run codegen:fixture`.

No test framework: `node:test` and `node:assert` are enough, and one fewer
dependency in a library is one fewer dependency for everyone consuming it.

## Roadmap

In order of usefulness, not of ease:

1. `REDEFINES`, exposing the alternative views instead of picking one
2. EBCDIC code pages 1047, 273 and 500
3. Streaming reads, for files that do not fit in memory

## Licence

MIT
