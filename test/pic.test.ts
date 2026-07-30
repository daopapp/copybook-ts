import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePic, tamanhoComp3, ErroPic } from '../src/pic.js';

test('expande repetição e conta dígitos', () => {
  assert.equal(parsePic('9(5)').tamanho, 5);
  assert.equal(parsePic('99999').tamanho, 5);
  assert.equal(parsePic('X(30)').tamanho, 30);
  // As duas notações coexistem no mesmo PIC
  assert.deepEqual(
    { d: parsePic('S9(3)V9(2)').digitos, e: parsePic('S9(3)V9(2)').escala },
    { d: 5, e: 2 },
  );
  assert.deepEqual(
    { d: parsePic('S999V99').digitos, e: parsePic('S999V99').escala },
    { d: 5, e: 2 },
  );
});

test('o V não ocupa byte, é posição de vírgula', () => {
  const c = parsePic('9(5)V99');
  assert.equal(c.tamanho, 7, 'sete dígitos, sete bytes em display');
  assert.equal(c.escala, 2);
  assert.equal(c.digitos, 7);
});

test('o S não ocupa byte quando o sinal fica na zona', () => {
  assert.equal(parsePic('S9(3)').tamanho, 3, 'sinal na zona não gasta byte');
  assert.equal(parsePic('9(3)').tamanho, 3);
  assert.equal(parsePic('S9(3)').assinado, true);
  assert.equal(parsePic('9(3)').assinado, false);
});

test('SIGN SEPARATE ocupa um byte a mais', () => {
  const zona = parsePic('S9(3)');
  const separado = parsePic('S9(3)', { sign: 'TRAILING SEPARATE' });
  assert.equal(zona.tamanho, 3);
  assert.equal(separado.tamanho, 4, 'o byte de sinal é físico aqui');
  assert.equal(separado.posicaoSinal, 'separate-trailing');
  assert.equal(parsePic('S9(3)', { sign: 'LEADING' }).posicaoSinal, 'leading');
});

test('tamanho de COMP-3 segue ceil((digitos + 1) / 2)', () => {
  // Vetores conferidos contra a fórmula do padrão
  assert.equal(tamanhoComp3(1), 1);
  assert.equal(tamanhoComp3(3), 2);
  assert.equal(tamanhoComp3(7), 4);
  assert.equal(tamanhoComp3(11), 6);
  assert.equal(parsePic('S9(5)V99', { usage: 'COMP-3' }).tamanho, 4);
  assert.equal(parsePic('S9(9)V99', { usage: 'PACKED-DECIMAL' }).tamanho, 6);
});

test('BINARY usa a faixa de dígitos, não a contagem', () => {
  assert.equal(parsePic('S9(4)', { usage: 'COMP' }).tamanho, 2);
  assert.equal(parsePic('S9(5)', { usage: 'BINARY' }).tamanho, 4);
  assert.equal(parsePic('S9(9)', { usage: 'COMP-4' }).tamanho, 4);
  assert.equal(parsePic('S9(10)', { usage: 'COMP' }).tamanho, 8);
  assert.equal(parsePic('S9(4)', { usage: 'COMP-1' }).tamanho, 4);
  assert.equal(parsePic('S9(4)', { usage: 'COMP-2' }).tamanho, 8);
});

test('rejeita PIC inválido em vez de adivinhar', () => {
  assert.throws(() => parsePic(''), ErroPic);
  assert.throws(() => parsePic('9(0)'), ErroPic, 'repetição zero');
  assert.throws(() => parsePic('9(3'), ErroPic, 'parêntese aberto');
  assert.throws(() => parsePic('X(3)9(2)'), ErroPic, 'mistura alfa com numérico');
  assert.throws(() => parsePic('9V9V9'), ErroPic, 'dois V');
  assert.throws(() => parsePic('SX(3)'), ErroPic, 'S em alfanumérico');
  assert.throws(() => parsePic('VVV'), ErroPic, 'numérico sem nenhum 9');
  assert.throws(() => parsePic('X(3)', { usage: 'COMP-3' }), ErroPic, 'COMP-3 em texto');
  assert.throws(() => parsePic('9(3)', { sign: 'LEADING' }), ErroPic, 'SIGN sem S');
  assert.throws(() => parsePic('9(19)', { usage: 'COMP' }), ErroPic, 'passa de 18 dígitos');
  assert.throws(() => parsePic('9(3)', { usage: 'COMP-9' }), ErroPic, 'USAGE inexistente');
});
