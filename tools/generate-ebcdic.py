#!/usr/bin/env python3
"""Generates src/ebcdic.ts from Python's cp037 codec.

The table has to come from a verifiable source: 256 hand-written bytes age
badly and nobody double-checks them. Run:

    python3 tools/generate-ebcdic.py > src/ebcdic.ts
"""
import codecs
import sys

HEADER = '''/**
 * EBCDIC code page 037 table.
 *
 * Generated from Python's `cp037` codec, not transcribed by hand. Regenerate with:
 *   python3 tools/generate-ebcdic.py > src/ebcdic.ts
 *
 * A byte with no mapping in the code page becomes U+FFFD.
 */

/** 256 characters, indexed by byte value. */
export const CP037 =
  '{table}';

if (CP037.length !== 256) {{
  throw new Error(`CP037 table is corrupt: ${{CP037.length}} characters, expected 256`);
}}

/** Decodes EBCDIC 037 bytes into text. */
export function decodeEbcdic(buf: Uint8Array): string {{
  let s = '';
  for (const b of buf) s += CP037[b];
  return s;
}}

const REVERSE = new Map<string, number>();
for (let b = 0; b < 256; b += 1) {{
  const ch = CP037[b]!;
  if (ch !== '\\ufffd' && !REVERSE.has(ch)) REVERSE.set(ch, b);
}}

/** Encodes text into EBCDIC 037. A character outside the page is an error, not a substitution. */
export function encodeEbcdic(text: string): Uint8Array {{
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {{
    const b = REVERSE.get(text[i]!);
    if (b === undefined) {{
      throw new Error(`character ${{JSON.stringify(text[i])}} does not exist in EBCDIC code page 037`);
    }}
    out[i] = b;
  }}
  return out;
}}
'''


def main() -> int:
    try:
        codecs.lookup("cp037")
    except LookupError:
        print(
            "cp037 codec missing from this Python: refusing to generate an invented table",
            file=sys.stderr,
        )
        return 1

    table = []
    for b in range(256):
        try:
            table.append(bytes([b]).decode("cp037"))
        except UnicodeDecodeError:
            table.append("�")

    # Self-check. If any of these fail the table is unusable, and generating
    # nothing beats generating wrong data that nobody will verify.
    assert len(table) == 256
    assert table[0xF0] == "0", "digit 0 in EBCDIC 037 is 0xF0"
    assert table[0x81] == "a", "letter a is 0x81"
    assert table[0x91] == "j", "there is a gap between i (0x89) and j (0x91)"
    assert table[0xC1] == "A", "letter A is 0xC1"
    assert table[0x40] == " ", "space is 0x40"

    escaped = "".join(
        c if 0x20 <= ord(c) < 0x7F and c not in "\\'" else f"\\u{ord(c):04x}"
        for c in table
    )
    sys.stdout.write(HEADER.format(table=escaped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
