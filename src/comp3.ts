/**
 * COMP-3, decimal empacotado.
 *
 * Dois dígitos por byte, e o último nibble carrega o sinal. Ler como binário
 * devolve um número errado, não um erro, e é por isso que este módulo falha
 * alto em nibble inválido em vez de normalizar.
 */

export class ErroComp3 extends Error {}

/** Nibbles de sinal aceitos na leitura. Alguns compiladores emitem A, B e E. */
const SINAL_POSITIVO = new Set([0xa, 0xc, 0xe, 0xf]);
const SINAL_NEGATIVO = new Set([0xb, 0xd]);

/**
 * Decodifica COMP-3 para string decimal.
 *
 * Devolve string, e não number, de propósito: `PIC S9(16)V99` passa de
 * `Number.MAX_SAFE_INTEGER`, e converter para double perderia centavos em
 * silêncio. Quem chama decide se quer BigInt, Decimal ou aceitar a perda.
 *
 * @param buf bytes do campo, exatamente do tamanho do campo
 * @param escala casas decimais (o que vem depois do V no PIC)
 */
export function decodeComp3(buf: Uint8Array, escala = 0): string {
  if (buf.length === 0) throw new ErroComp3('campo COMP-3 vazio');
  if (escala < 0) throw new ErroComp3(`escala negativa: ${escala}`);

  const nibbles: number[] = [];
  for (const byte of buf) {
    nibbles.push((byte >> 4) & 0xf, byte & 0xf);
  }

  const sinal = nibbles.pop()!;
  let negativo: boolean;
  if (SINAL_NEGATIVO.has(sinal)) negativo = true;
  else if (SINAL_POSITIVO.has(sinal)) negativo = false;
  else {
    // Nibble de sinal fora do conjunto quase sempre significa que o
    // deslocamento do campo está errado, não que o dado é exótico.
    throw new ErroComp3(
      `nibble de sinal inválido 0x${sinal.toString(16).toUpperCase()}: ` +
        'provável deslocamento de campo errado',
    );
  }

  let digitos = '';
  for (const n of nibbles) {
    if (n > 9) {
      throw new ErroComp3(
        `nibble de dado inválido 0x${n.toString(16).toUpperCase()}: ` +
          'provável deslocamento de campo errado',
      );
    }
    digitos += String(n);
  }

  if (escala > digitos.length) {
    throw new ErroComp3(`escala ${escala} maior que os ${digitos.length} dígitos do campo`);
  }

  const inteiro = (escala ? digitos.slice(0, digitos.length - escala) : digitos) || '0';
  const fracao = escala ? digitos.slice(digitos.length - escala) : '';
  const semZeros = inteiro.replace(/^0+(?=\d)/, '');
  const corpo = fracao ? `${semZeros}.${fracao}` : semZeros;

  // Zero negativo existe em COMP-3 e vale zero. Emitir "-0.00" seria
  // tecnicamente fiel e praticamente um bug para quem compara strings.
  const ehZero = /^0(\.0*)?$/.test(corpo);
  return negativo && !ehZero ? `-${corpo}` : corpo;
}

/**
 * Codifica string decimal em COMP-3.
 *
 * Na escrita emitimos só C, D ou F. Ser tolerante na leitura e estrito na
 * escrita evita propagar variação de compilador.
 */
export function encodeComp3(
  valor: string,
  digitos: number,
  escala = 0,
  opcoes: { assinado?: boolean } = {},
): Uint8Array {
  const assinado = opcoes.assinado ?? true;

  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(valor.trim());
  if (!m || (!m[2] && !m[3])) throw new ErroComp3(`valor decimal inválido: "${valor}"`);

  const negativo = m[1] === '-';
  const inteiro = m[2] ?? '';
  const fracao = m[3] ?? '';

  if (fracao.length > escala) {
    throw new ErroComp3(
      `"${valor}" tem ${fracao.length} casas decimais, o campo aceita ${escala}`,
    );
  }

  const todos = inteiro + fracao.padEnd(escala, '0');
  const semZeros = todos.replace(/^0+(?=\d)/, '') || '0';
  if (semZeros.length > digitos) {
    throw new ErroComp3(
      `"${valor}" precisa de ${semZeros.length} dígitos, o campo tem ${digitos}`,
    );
  }
  if (negativo && !assinado) {
    throw new ErroComp3(`valor negativo em campo sem sinal: "${valor}"`);
  }

  const nib = (semZeros.padStart(digitos, '0') + (assinado ? (negativo ? 'D' : 'C') : 'F')).split(
    '',
  );
  if (nib.length % 2) nib.unshift('0');

  const out = new Uint8Array(nib.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (parseInt(nib[i * 2]!, 16) << 4) | parseInt(nib[i * 2 + 1]!, 16);
  }
  return out;
}
