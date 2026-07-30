/**
 * Tabela EBCDIC pagina 037.
 *
 * Gerada a partir do codec `cp037` do Python, nao transcrita a mao. Regerar com:
 *   python3 tools/gerar-ebcdic.py > src/ebcdic.ts
 *
 * Byte sem mapeamento na pagina vira U+FFFD.
 */

/** 256 caracteres, indexados pelo byte. */
export const CP037 =
  '\u0000\u0001\u0002\u0003\u009c\u0009\u0086\u007f\u0097\u008d\u008e\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u009d\u0085\u0008\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f\u0080\u0081\u0082\u0083\u0084\u000a\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2.<(+|&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df!$*);\u00ac-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@\u0027="\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae^\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be[]\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\u005c\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f';

if (CP037.length !== 256) {
  throw new Error(`tabela CP037 corrompida: ${CP037.length} caracteres, esperado 256`);
}

/** Decodifica bytes EBCDIC 037 para texto. */
export function decodeEbcdic(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += CP037[b];
  return s;
}

const REVERSO = new Map<string, number>();
for (let b = 0; b < 256; b += 1) {
  const ch = CP037[b]!;
  if (ch !== '\ufffd' && !REVERSO.has(ch)) REVERSO.set(ch, b);
}

/** Codifica texto para EBCDIC 037. Caractere fora da pagina e' erro, nao substituicao. */
export function encodeEbcdic(texto: string): Uint8Array {
  const out = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i += 1) {
    const b = REVERSO.get(texto[i]!);
    if (b === undefined) {
      throw new Error(`caractere ${JSON.stringify(texto[i])} nao existe na pagina EBCDIC 037`);
    }
    out[i] = b;
  }
  return out;
}
