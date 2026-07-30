# copybook-ts

Interpreta copybook COBOL e decodifica registro posicional de mainframe em
TypeScript. COMP-3, EBCDIC, vírgula implícita e sinal na zona tratados como
regra, não como caso especial.

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Por que existe

Dado de mainframe não erra com exceção. Erra com um número silenciosamente
diferente. `PIC S9(5)V99` lido como inteiro devolve `1234567` em vez de
`12345.67`, e nada reclama. Um campo com o tamanho errado desloca todos os
campos seguintes, e o registro inteiro decodifica em cascata.

As bibliotecas que existem em npm resolvem pedaços: conversão de caractere
EBCDIC, ou parse de um layout específico. Nenhuma vai de copybook a valor
tipado tratando os casos que realmente aparecem em arquivo de banco e de
seguradora.

## Instalação

```
npm install copybook-ts
```

Node 20 ou mais novo. Nenhuma dependência de produção.

## Uso

```ts
import { parseCopybook, decodeArquivo } from 'copybook-ts';
import { readFileSync } from 'node:fs';

const layout = parseCopybook(readFileSync('CLIENTE.cpy', 'utf8'));
console.log(layout.tamanho); // 35

for (const reg of decodeArquivo(readFileSync('CLIENTE.DAT'), layout, { encoding: 'cp037' })) {
  console.log(reg);
  // { 'CD-CLIENTE': '4711', 'NM-CLIENTE': 'MARIA SILVA         ',
  //   'VL-SALDO': '12345.67', 'QT-COMPRAS': '42', 'CD-STATUS': '7' }
}
```

Campos numéricos voltam como **string**, não `number`. `PIC S9(16)V99` passa de
`Number.MAX_SAFE_INTEGER`, e converter para double perderia centavos sem avisar.
Quem chama decide entre `BigInt`, uma biblioteca decimal, ou aceitar a perda.

## O que está tratado

| Assunto | Estado |
|---|---|
| `PIC X`, `PIC 9`, com e sem `(n)` | sim |
| Vírgula implícita (`V`) | sim |
| Sinal na zona (`S`), trailing e leading | sim |
| `SIGN SEPARATE`, que ocupa um byte a mais | sim |
| `COMP-3` / `PACKED-DECIMAL` | sim, decodifica e codifica |
| `COMP` / `COMP-4` / `BINARY`, big-endian com complemento de dois | sim |
| `COMP-1` e `COMP-2` (float) | sim |
| Itens de grupo, tamanho pela soma dos filhos | sim |
| Níveis 66 e 88, que não ocupam espaço | sim |
| Área de sequência e comentário do formato fixo | sim |
| EBCDIC página 037 | sim |
| Record Descriptor Word (`RECFM=VB`) | sim, via `{ rdw: true }` |
| `REDEFINES` | **recusa com erro** |
| `OCCURS` e `OCCURS DEPENDING ON` | **recusa com erro** |
| Páginas EBCDIC além da 037 | não |

`REDEFINES` e `OCCURS` **falham alto de propósito**. Os dois mudam como o
deslocamento é calculado. Aceitá-los sem implementar produziria um layout que
decodifica sem reclamar e devolve valores errados, que é o pior resultado
possível numa biblioteca como esta.

## Decisões que valem explicar

**Tolerante na leitura, estrito na escrita.** Nibble de sinal `A` e `E` é aceito
como positivo e `B` como negativo, porque alguns compiladores emitem isso.
Na escrita só saem `C`, `D` e `F`, para não propagar variação de compilador.

**Nibble inválido é erro, não valor exótico.** Um nibble de sinal fora de
`A B C D E F`, ou um nibble de dado maior que 9, quase sempre significa que o
deslocamento do campo está errado. Normalizar em silêncio esconde o erro e
propaga pelo registro inteiro.

**Numérico em display não passa por tabela de caracteres.** O dígito é o nibble
baixo do byte, o que vale igual em EBCDIC (`0xF1`) e ASCII (`0x31`). Converter o
byte para texto antes de extrair o dígito é o bug clássico: `0xD3`, que é o
dígito 3 com sinal negativo, vira a letra `L`. Existe um teste que trava
exatamente isso.

**A divisão do arquivo é a validação mais barata que existe.** Se o arquivo não
é múltiplo do tamanho do registro, o copybook não corresponde ao dado, e isso é
detectado antes de olhar qualquer valor.

**A tabela EBCDIC é gerada, não transcrita.** `src/ebcdic.ts` vem do codec
`cp037` do Python, com autoteste nos pontos que importam (`0xF0` é `0`, há salto
entre `i` e `j`). 256 bytes escritos à mão envelhecem errado e ninguém confere.

```
npm run ebcdic    # regenera src/ebcdic.ts
```

## Desenvolvimento

```
npm test          # compila e roda os 30 testes com o runner nativo do Node
npm run typecheck
```

Sem framework de teste: `node:test` e `node:assert` bastam, e uma dependência a
menos numa biblioteca é uma dependência a menos para quem consome.

## Roteiro

Em ordem de utilidade, não de facilidade:

1. `OCCURS` e `OCCURS DEPENDING ON`, com layout resolvido por registro
2. `REDEFINES`, expondo as vistas alternativas em vez de escolher uma
3. Geração de tipos TypeScript a partir do copybook, via CLI
4. Páginas EBCDIC 1047, 273 e 500
5. Leitura em stream, para arquivo que não cabe na memória

## Licença

MIT
