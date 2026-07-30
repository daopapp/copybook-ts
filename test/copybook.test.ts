import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, ErroCopybook } from '../src/copybook.js';
import { decodeRegistro, decodeArquivo, ErroDecode } from '../src/decode.js';
import { encodeComp3 } from '../src/comp3.js';
import { encodeEbcdic } from '../src/ebcdic.js';

const CLIENTE = `
      * Cadastro de cliente, layout de exemplo
       01  CLIENTE.
           05  CD-CLIENTE      PIC 9(5).
           05  NM-CLIENTE      PIC X(20).
           05  VL-SALDO        PIC S9(7)V99 COMP-3.
           05  QT-COMPRAS      PIC S9(4) COMP.
           05  CD-STATUS       PIC S9(3).
`;

test('calcula tamanho e deslocamento na ordem certa', () => {
  const l = parseCopybook(CLIENTE);
  assert.equal(l.nome, 'CLIENTE');
  assert.deepEqual(
    l.campos.map((c) => [c.item.nome, c.item.deslocamento, c.item.tamanho]),
    [
      ['CD-CLIENTE', 0, 5],
      ['NM-CLIENTE', 5, 20],
      ['VL-SALDO', 25, 5], // 9 dígitos -> ceil(10/2) = 5
      ['QT-COMPRAS', 30, 2], // 4 dígitos em COMP -> 2 bytes
      ['CD-STATUS', 32, 3], // sinal na zona, não gasta byte
    ],
  );
  assert.equal(l.tamanho, 35);
});

test('item de grupo é a soma dos filhos, e não é contado duas vezes', () => {
  const l = parseCopybook(`
       01  REG.
           05  CAB.
               10  TP        PIC X.
               10  DT        PIC 9(8).
           05  CORPO.
               10  A         PIC X(10).
               10  B         PIC X(10).
  `);
  assert.equal(l.tamanho, 29, '1 + 8 + 10 + 10');
  assert.equal(l.raiz.filhos[0]!.tamanho, 9, 'CAB');
  assert.equal(l.raiz.filhos[1]!.deslocamento, 9, 'CORPO começa depois de CAB');
  assert.equal(l.campos.length, 4, 'só os elementares aparecem achatados');
});

test('níveis 66 e 88 não ocupam espaço', () => {
  const l = parseCopybook(`
       01  REG.
           05  ST            PIC X.
               88  ATIVO     VALUE 'A'.
               88  INATIVO   VALUE 'I'.
           05  NOME          PIC X(10).
  `);
  assert.equal(l.tamanho, 11, '88 não é campo');
  assert.equal(l.campos.length, 2);
});

test('ignora comentário e área de sequência do formato fixo', () => {
  const l = parseCopybook(
    '000100* comentario com numero de sequencia\n' +
      '000200 01  REG.\n' +
      '000300     05  A  PIC X(3).\n',
  );
  assert.equal(l.tamanho, 3);
  assert.equal(l.campos[0]!.item.nome, 'A');
});

test('rejeita REDEFINES e OCCURS em vez de calcular deslocamento errado', () => {
  // Aceitar sem implementar produziria um layout que decodifica sem reclamar,
  // devolvendo valores errados. Falhar alto é o comportamento correto.
  assert.throws(
    () => parseCopybook('       01  R.\n           05  A PIC X(4).\n           05  B REDEFINES A PIC 9(4).\n'),
    ErroCopybook,
  );
  assert.throws(
    () => parseCopybook('       01  R.\n           05  N PIC 9(2).\n           05  I OCCURS 1 TO 5 DEPENDING ON N PIC X.\n'),
    ErroCopybook,
  );
});

test('rejeita copybook malformado', () => {
  assert.throws(() => parseCopybook(''), ErroCopybook, 'vazio');
  assert.throws(() => parseCopybook('       05  A PIC X.\n'), ErroCopybook, 'não começa em 01');
  assert.throws(() => parseCopybook('       01  R.\n           05  G.\n'), ErroCopybook, 'grupo sem filho');
  assert.throws(
    () => parseCopybook('       01  R.\n           05  A PIC X(3) \n'),
    ErroCopybook,
    'sentença sem ponto',
  );
});

// ---------------------------------------------------------------------------
// Ponta a ponta: monta um registro EBCDIC real e decodifica.
// ---------------------------------------------------------------------------

function registroCliente(cd: string, nome: string, saldo: string, qt: number, status: number) {
  const layout = parseCopybook(CLIENTE);
  const buf = new Uint8Array(layout.tamanho);

  buf.set(encodeEbcdic(cd.padStart(5, '0')), 0);
  buf.set(encodeEbcdic(nome.padEnd(20, ' ')), 5);
  buf.set(encodeComp3(saldo, 9, 2), 25);

  // COMP: big-endian, complemento de dois
  new DataView(buf.buffer).setInt16(30, qt, false);

  // DISPLAY assinado: dígitos com zona F, sinal no nibble alto do último byte
  const d = String(Math.abs(status)).padStart(3, '0');
  buf[32] = 0xf0 | Number(d[0]);
  buf[33] = 0xf0 | Number(d[1]);
  buf[34] = (status < 0 ? 0xd0 : 0xc0) | Number(d[2]);

  return { layout, buf };
}

test('decodifica registro EBCDIC de ponta a ponta', () => {
  const { layout, buf } = registroCliente('4711', 'MARIA SILVA', '12345.67', 42, 7);
  const r = decodeRegistro(buf, layout, { encoding: 'cp037' });

  assert.equal(r['CD-CLIENTE'], '4711');
  assert.equal(r['NM-CLIENTE'], 'MARIA SILVA         ');
  assert.equal(r['VL-SALDO'], '12345.67');
  assert.equal(r['QT-COMPRAS'], '42');
  assert.equal(r['CD-STATUS'], '7');
});

test('valor negativo funciona em COMP-3, COMP e DISPLAY', () => {
  const { layout, buf } = registroCliente('1', 'X', '-99.50', -7, -3);
  const r = decodeRegistro(buf, layout, { encoding: 'cp037' });
  assert.equal(r['VL-SALDO'], '-99.50', 'COMP-3 com nibble D');
  assert.equal(r['QT-COMPRAS'], '-7', 'COMP em complemento de dois');
  assert.equal(r['CD-STATUS'], '-3', 'DISPLAY com zona de sinal D');
});

test('a zona de sinal é o bug que este teste existe para travar', () => {
  // 0xD3 decodificado como texto EBCDIC devolve 'L', não '3'. Se alguém
  // reescrever o caminho de DISPLAY passando por tabela de caracteres, este
  // teste quebra.
  const { layout, buf } = registroCliente('1', 'X', '0', 0, -123);
  const r = decodeRegistro(buf, layout, { encoding: 'cp037' });
  assert.equal(r['CD-STATUS'], '-123');
  assert.equal(buf[34], 0xd3, 'último byte tem zona D e dígito 3');
});

test('registro truncado falha em vez de devolver campo vazio', () => {
  const { layout, buf } = registroCliente('1', 'X', '1', 1, 1);
  assert.throws(() => decodeRegistro(buf.subarray(0, 30), layout, { encoding: 'cp037' }), ErroDecode);
});

test('arquivo que não é múltiplo do registro falha na divisão', () => {
  // A checagem mais barata de layout errado que existe.
  const { layout, buf } = registroCliente('1', 'X', '1', 1, 1);
  const doisEMeio = new Uint8Array(layout.tamanho * 2 + 7);
  doisEMeio.set(buf, 0);
  assert.throws(
    () => [...decodeArquivo(doisEMeio, layout, { encoding: 'cp037' })],
    ErroDecode,
  );
});

test('divide arquivo de múltiplos registros', () => {
  const a = registroCliente('1', 'ANA', '10.00', 1, 1);
  const bb = registroCliente('2', 'BOB', '20.00', 2, 2);
  const arquivo = new Uint8Array(a.buf.length * 2);
  arquivo.set(a.buf, 0);
  arquivo.set(bb.buf, a.buf.length);

  const regs = [...decodeArquivo(arquivo, a.layout, { encoding: 'cp037' })];
  assert.equal(regs.length, 2);
  assert.equal(regs[0]!['NM-CLIENTE'], 'ANA                 ');
  assert.equal(regs[1]!['VL-SALDO'], '20.00');
});

test('RDW desloca 4 bytes, e ignorá-lo é o erro clássico', () => {
  const { layout, buf } = registroCliente('4711', 'MARIA', '1.00', 1, 1);
  const comRdw = new Uint8Array(4 + buf.length);
  new DataView(comRdw.buffer).setUint16(0, comRdw.length, false);
  comRdw.set(buf, 4);

  const certo = decodeRegistro(comRdw, layout, { encoding: 'cp037', rdw: true });
  assert.equal(certo['CD-CLIENTE'], '4711');

  // Sem tratar o RDW, o primeiro campo sai errado ou estoura. Qualquer um dos
  // dois é aceitável aqui: o que não pode é devolver 4711.
  let resultado: string | null = null;
  try {
    resultado = String(decodeRegistro(comRdw, layout, { encoding: 'cp037' })['CD-CLIENTE']);
  } catch {
    resultado = 'estourou';
  }
  assert.notEqual(resultado, '4711', 'ignorar o RDW não pode dar o valor certo por acidente');
});
