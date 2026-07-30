#!/usr/bin/env python3
"""Gera src/ebcdic.ts a partir do codec cp037 do Python.

A tabela precisa vir de fonte verificavel: 256 bytes escritos a mao envelhecem
errado e ninguem confere. Rodar:

    python3 tools/gerar-ebcdic.py > src/ebcdic.ts
"""
import codecs
import sys

CABECALHO = '''/**
 * Tabela EBCDIC pagina 037.
 *
 * Gerada a partir do codec `cp037` do Python, nao transcrita a mao. Regerar com:
 *   python3 tools/gerar-ebcdic.py > src/ebcdic.ts
 *
 * Byte sem mapeamento na pagina vira U+FFFD.
 */

/** 256 caracteres, indexados pelo byte. */
export const CP037 =
  '{tabela}';

if (CP037.length !== 256) {{
  throw new Error(`tabela CP037 corrompida: ${{CP037.length}} caracteres, esperado 256`);
}}

/** Decodifica bytes EBCDIC 037 para texto. */
export function decodeEbcdic(buf: Uint8Array): string {{
  let s = '';
  for (const b of buf) s += CP037[b];
  return s;
}}

const REVERSO = new Map<string, number>();
for (let b = 0; b < 256; b += 1) {{
  const ch = CP037[b]!;
  if (ch !== '\\ufffd' && !REVERSO.has(ch)) REVERSO.set(ch, b);
}}

/** Codifica texto para EBCDIC 037. Caractere fora da pagina e' erro, nao substituicao. */
export function encodeEbcdic(texto: string): Uint8Array {{
  const out = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i += 1) {{
    const b = REVERSO.get(texto[i]!);
    if (b === undefined) {{
      throw new Error(`caractere ${{JSON.stringify(texto[i])}} nao existe na pagina EBCDIC 037`);
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
            "codec cp037 ausente neste Python: nao vou gerar tabela inventada",
            file=sys.stderr,
        )
        return 1

    tabela = []
    for b in range(256):
        try:
            tabela.append(bytes([b]).decode("cp037"))
        except UnicodeDecodeError:
            tabela.append("�")

    # Autoteste. Se qualquer um destes falhar, a tabela nao serve, e nao gerar
    # nada e' melhor que gerar dado errado que ninguem vai conferir.
    assert len(tabela) == 256
    assert tabela[0xF0] == "0", "digito 0 em EBCDIC 037 e' 0xF0"
    assert tabela[0x81] == "a", "letra a e' 0x81"
    assert tabela[0x91] == "j", "ha salto entre i (0x89) e j (0x91)"
    assert tabela[0xC1] == "A", "letra A e' 0xC1"
    assert tabela[0x40] == " ", "espaco e' 0x40"

    escapado = "".join(
        c if 0x20 <= ord(c) < 0x7F and c not in "\\'" else f"\\u{ord(c):04x}"
        for c in tabela
    )
    sys.stdout.write(CABECALHO.format(tabela=escapado))
    return 0


if __name__ == "__main__":
    sys.exit(main())
