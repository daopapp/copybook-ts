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
| Record Descriptor Word (`RECFM=VB`) | yes, via `{ rdw: true }` |
| `REDEFINES` | **refuses with an error** |
| `OCCURS` and `OCCURS DEPENDING ON` | **refuses with an error** |
| EBCDIC code pages other than 037 | no |

`REDEFINES` and `OCCURS` **fail loudly on purpose**. Both change how offsets are
computed. Accepting them unimplemented would produce a layout that decodes
without complaint and returns wrong values, which is the worst possible outcome
for a library like this one.

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

**Dividing the file is the cheapest validation available.** If the file is not a
multiple of the record size, the copybook does not match the data, and that is
caught before looking at a single value.

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
npm test          # compiles and runs 30 tests on Node's built-in runner
npm run typecheck
```

No test framework: `node:test` and `node:assert` are enough, and one fewer
dependency in a library is one fewer dependency for everyone consuming it.

## Roadmap

In order of usefulness, not of ease:

1. `OCCURS` and `OCCURS DEPENDING ON`, with the layout resolved per record
2. `REDEFINES`, exposing the alternative views instead of picking one
3. TypeScript type generation from a copybook, via a CLI
4. EBCDIC code pages 1047, 273 and 500
5. Streaming reads, for files that do not fit in memory

## Licence

MIT
