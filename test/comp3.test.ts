import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeComp3, encodeComp3, ErroComp3 } from '../src/comp3.js';

const b = (...n: number[]) => Uint8Array.of(...n);
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join(' ');

test('decodifica os vetores canônicos de PIC S9(5)V99 COMP-3', () => {
  assert.equal(decodeComp3(b(0x12, 0x34, 0x56, 0x7c), 2), '12345.67');
  assert.equal(decodeComp3(b(0x12, 0x34, 0x56, 0x7d), 2), '-12345.67');
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x0c), 2), '0.00');
  assert.equal(decodeComp3(b(0x99, 0x99, 0x99, 0x9c), 2), '99999.99');
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x1d), 2), '-0.01');
});

test('sem escala devolve inteiro', () => {
  assert.equal(decodeComp3(b(0x12, 0x3f)), '123');
  assert.equal(decodeComp3(b(0x7d)), '-7');
});

test('zero negativo vale zero, não "-0"', () => {
  // Existe em COMP-3 e é um zero. Emitir "-0.00" quebraria comparação de string.
  assert.equal(decodeComp3(b(0x00, 0x00, 0x00, 0x0d), 2), '0.00');
  assert.equal(decodeComp3(b(0x0d)), '0');
});

test('aceita A, B e E como sinal na leitura', () => {
  // Alguns compiladores emitem esses nibbles. Rejeitar recusaria dado válido.
  assert.equal(decodeComp3(b(0x12, 0x3a)), '123', 'A é positivo');
  assert.equal(decodeComp3(b(0x12, 0x3e)), '123', 'E é positivo');
  assert.equal(decodeComp3(b(0x12, 0x3b)), '-123', 'B é negativo');
  assert.equal(decodeComp3(b(0x12, 0x3f)), '123', 'F é sem sinal');
});

test('falha alto em nibble inválido em vez de devolver número errado', () => {
  // Este é o ponto do módulo: nibble estranho quase sempre é deslocamento
  // errado, e normalizar em silêncio propaga o erro pelo registro inteiro.
  assert.throws(() => decodeComp3(b(0x12, 0x30)), ErroComp3, 'sinal 0 não existe');
  assert.throws(() => decodeComp3(b(0x12, 0x39)), ErroComp3, 'sinal 9 não existe');
  assert.throws(() => decodeComp3(b(0x1a, 0x2c)), ErroComp3, 'nibble de dado A');
  assert.throws(() => decodeComp3(b()), ErroComp3, 'campo vazio');
  assert.throws(() => decodeComp3(b(0x1c), 5), ErroComp3, 'escala maior que os dígitos');
});

test('codifica e devolve exatamente os bytes esperados', () => {
  assert.equal(hex(encodeComp3('12345.67', 7, 2)), '12 34 56 7c');
  assert.equal(hex(encodeComp3('-12345.67', 7, 2)), '12 34 56 7d');
  assert.equal(hex(encodeComp3('0', 7, 2)), '00 00 00 0c');
  assert.equal(hex(encodeComp3('123', 3, 0, { assinado: false })), '12 3f');
  assert.equal(hex(encodeComp3('123456789.01', 11, 2)), '12 34 56 78 90 1c');
});

test('na escrita emite só C, D ou F', () => {
  // Tolerante na leitura, estrito na escrita: não propaga variação de compilador.
  const sinal = (u: Uint8Array) => u[u.length - 1]! & 0x0f;
  assert.equal(sinal(encodeComp3('1', 3, 0)), 0xc);
  assert.equal(sinal(encodeComp3('-1', 3, 0)), 0xd);
  assert.equal(sinal(encodeComp3('1', 3, 0, { assinado: false })), 0xf);
});

test('codificação rejeita o que não cabe', () => {
  assert.throws(() => encodeComp3('123456', 3, 0), ErroComp3, 'mais dígitos que o campo');
  assert.throws(() => encodeComp3('1.234', 7, 2), ErroComp3, 'mais casas decimais que a escala');
  assert.throws(() => encodeComp3('-1', 3, 0, { assinado: false }), ErroComp3, 'negativo sem sinal');
  assert.throws(() => encodeComp3('abc', 3, 0), ErroComp3, 'não é decimal');
  assert.throws(() => encodeComp3('', 3, 0), ErroComp3, 'vazio');
});

test('ida e volta preserva o valor', () => {
  for (const v of ['0.00', '1.00', '-1.00', '12345.67', '-12345.67', '99999.99', '-0.01']) {
    assert.equal(decodeComp3(encodeComp3(v, 7, 2), 2), v === '-0.00' ? '0.00' : v, `valor ${v}`);
  }
});

test('campo grande não perde precisão', () => {
  // PIC S9(16)V99 passa de Number.MAX_SAFE_INTEGER. É por isso que a API
  // devolve string em vez de number.
  const grande = '9007199254740993.99';
  assert.equal(decodeComp3(encodeComp3(grande, 18, 2), 2), grande);
  assert.notEqual(String(Number(grande)), grande, 'confirma que double perderia');
});
