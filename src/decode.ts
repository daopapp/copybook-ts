/**
 * Decodificação de registro posicional a partir de um layout.
 *
 * Regra que o módulo inteiro respeita: nunca converter o registro inteiro para
 * texto antes de fatiar. Campo COMP-3 e BINARY são binários, não têm
 * codificação, e passá-los por uma tabela de caracteres destrói o valor.
 */

import { decodeComp3 } from './comp3.js';
import { decodeEbcdic } from './ebcdic.js';
import type { Item, Layout } from './copybook.js';

export class ErroDecode extends Error {}

export type Encoding = 'cp037' | 'ascii';

export interface OpcoesDecode {
  /** Codificação dos campos de texto e display. Obrigatória por escolha. */
  encoding: Encoding;
  /**
   * Se o arquivo tem Record Descriptor Word de 4 bytes por registro (RECFM=VB).
   * Ignorar o RDW desloca tudo em 4 bytes, e o sintoma é o primeiro campo sair
   * consistentemente errado.
   */
  rdw?: boolean | undefined;
}

/** Valor decimal fica como string para não perder precisão em campo grande. */
export type Valor = string | number | null;

export type Registro = Record<string, Valor>;

function texto(buf: Uint8Array, enc: Encoding): string {
  if (enc === 'cp037') return decodeEbcdic(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return s;
}

/**
 * Numérico em DISPLAY (zoned decimal).
 *
 * O dígito é sempre o nibble baixo, o que vale em EBCDIC (`0xF1`) e em ASCII
 * (`0x31`). Por isso este caminho não precisa de tabela de caracteres, e por
 * isso ele funciona nas duas codificações sem ramificar.
 *
 * O sinal fica no nibble alto do último byte quando o campo é assinado:
 * `C` positivo, `D` negativo, `F` sem sinal.
 */
function displayNumerico(buf: Uint8Array, item: Item): string {
  const campo = item.campo!;
  let corpo = buf;
  let negativoSeparado: boolean | null = null;

  if (campo.assinado && campo.posicaoSinal.startsWith('separate')) {
    const leading = campo.posicaoSinal === 'separate-leading';
    const byteSinal = leading ? buf[0]! : buf[buf.length - 1]!;
    const ch = texto(Uint8Array.of(byteSinal), 'cp037');
    const chAscii = String.fromCharCode(byteSinal);
    if (ch === '-' || chAscii === '-') negativoSeparado = true;
    else if (ch === '+' || chAscii === '+') negativoSeparado = false;
    else throw new ErroDecode(`${item.nome}: byte de sinal separado inválido 0x${byteSinal.toString(16)}`);
    corpo = leading ? buf.slice(1) : buf.slice(0, -1);
  }

  let digitos = '';
  let negativo = negativoSeparado ?? false;

  for (let i = 0; i < corpo.length; i += 1) {
    const b = corpo[i]!;
    const baixo = b & 0x0f;
    if (baixo > 9) {
      throw new ErroDecode(
        `${item.nome}: nibble de dígito inválido 0x${baixo.toString(16)} na posição ${i}: ` +
          'provável deslocamento de campo errado',
      );
    }
    digitos += String(baixo);

    const ultimo = i === corpo.length - 1;
    const primeiro = i === 0;
    const carregaSinal =
      campo.assinado &&
      negativoSeparado === null &&
      ((campo.posicaoSinal === 'trailing' && ultimo) ||
        (campo.posicaoSinal === 'leading' && primeiro));

    if (carregaSinal) {
      const alto = (b >> 4) & 0x0f;
      if (alto === 0xd || alto === 0xb) negativo = true;
      else if (alto === 0xc || alto === 0xa || alto === 0xe || alto === 0xf) negativo = false;
      else if (alto === 0x3) negativo = false; // ASCII: '0'-'9' tem zona 0x3
      else {
        throw new ErroDecode(
          `${item.nome}: zona de sinal inválida 0x${alto.toString(16)} no byte ${i}`,
        );
      }
    }
  }

  const escala = campo.escala;
  if (escala > digitos.length) {
    throw new ErroDecode(`${item.nome}: escala ${escala} maior que ${digitos.length} dígitos`);
  }
  const inteiro = (escala ? digitos.slice(0, digitos.length - escala) : digitos) || '0';
  const fracao = escala ? digitos.slice(digitos.length - escala) : '';
  const semZeros = inteiro.replace(/^0+(?=\d)/, '');
  const corpoStr = fracao ? `${semZeros}.${fracao}` : semZeros;
  const ehZero = /^0(\.0*)?$/.test(corpoStr);
  return negativo && !ehZero ? `-${corpoStr}` : corpoStr;
}

/** BINARY (COMP) é inteiro big-endian com sinal em complemento de dois. */
function binario(buf: Uint8Array, item: Item): string {
  const campo = item.campo!;
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);

  if (campo.assinado) {
    const bits = BigInt(buf.length * 8);
    const limite = 1n << (bits - 1n);
    if (v >= limite) v -= 1n << bits;
  }

  if (campo.escala === 0) return v.toString();
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(campo.escala + 1, '0');
  const corte = abs.length - campo.escala;
  return `${neg ? '-' : ''}${abs.slice(0, corte)}.${abs.slice(corte)}`;
}

/** Decodifica um único campo elementar. */
export function decodeCampo(buf: Uint8Array, item: Item, opcoes: OpcoesDecode): Valor {
  const campo = item.campo;
  if (!campo) throw new ErroDecode(`${item.nome} não é campo elementar`);

  const fatia = buf.subarray(item.deslocamento, item.deslocamento + item.tamanho);
  if (fatia.length !== item.tamanho) {
    throw new ErroDecode(
      `${item.nome}: esperava ${item.tamanho} bytes no deslocamento ${item.deslocamento}, ` +
        `só há ${fatia.length}: registro truncado`,
    );
  }

  if (campo.categoria === 'alfanumerico') return texto(fatia, opcoes.encoding);

  switch (campo.usage) {
    case 'DISPLAY':
      return displayNumerico(fatia, item);
    case 'COMP-3':
      try {
        return decodeComp3(fatia, campo.escala);
      } catch (e) {
        throw new ErroDecode(`${item.nome}: ${(e as Error).message}`);
      }
    case 'BINARY':
      return binario(fatia, item);
    case 'COMP-1':
      return new DataView(fatia.buffer, fatia.byteOffset, 4).getFloat32(0, false);
    case 'COMP-2':
      return new DataView(fatia.buffer, fatia.byteOffset, 8).getFloat64(0, false);
  }
}

/**
 * Decodifica um registro completo.
 *
 * @param buf bytes de exatamente um registro
 */
export function decodeRegistro(buf: Uint8Array, layout: Layout, opcoes: OpcoesDecode): Registro {
  const corpo = opcoes.rdw ? buf.subarray(4) : buf;
  if (corpo.length < layout.tamanho) {
    throw new ErroDecode(
      `registro tem ${corpo.length} bytes, o layout ${layout.nome} precisa de ${layout.tamanho}`,
    );
  }

  const out: Registro = {};
  for (const { caminho, item } of layout.campos) {
    // Nome curto se não colide, caminho completo se colide. Copybook usa o
    // mesmo nome em ramos diferentes com frequência.
    const chave = layout.campos.filter((c) => c.item.nome === item.nome).length === 1
      ? item.nome
      : caminho;
    out[chave] = decodeCampo(corpo, item, opcoes);
  }
  return out;
}

/**
 * Divide um arquivo de registros de tamanho fixo e decodifica cada um.
 *
 * A divisão é a checagem mais barata de layout errado que existe: se o arquivo
 * não é múltiplo do tamanho do registro, o copybook não corresponde ao dado.
 */
export function* decodeArquivo(
  buf: Uint8Array,
  layout: Layout,
  opcoes: OpcoesDecode,
): Generator<Registro> {
  const passo = layout.tamanho + (opcoes.rdw ? 4 : 0);
  if (buf.length % passo !== 0) {
    throw new ErroDecode(
      `arquivo tem ${buf.length} bytes, que não é múltiplo de ${passo}. ` +
        'O copybook não corresponde ao dado, ou falta tratar o RDW.',
    );
  }
  for (let i = 0; i < buf.length; i += passo) {
    yield decodeRegistro(buf.subarray(i, i + passo), layout, opcoes);
  }
}
