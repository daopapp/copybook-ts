/**
 * Copybook COBOL para árvore de layout com deslocamentos.
 *
 * Ordem de trabalho, e a ordem importa:
 *   1. montar a árvore de níveis sem calcular nada
 *   2. calcular tamanho de baixo para cima
 *   3. calcular deslocamento de cima para baixo
 *
 * Inverter os passos 2 e 3 produz deslocamento errado em qualquer item de
 * grupo, porque o tamanho do grupo é a soma dos filhos.
 */

import { parsePic, type CampoPic } from './pic.js';

export class ErroCopybook extends Error {}

export interface Item {
  readonly nivel: number;
  readonly nome: string;
  /** Presente só em item elementar. Item de grupo não tem PIC. */
  readonly campo?: CampoPic | undefined;
  readonly filhos: Item[];
  /** Deslocamento em bytes desde o início do registro. */
  deslocamento: number;
  tamanho: number;
}

export interface Layout {
  readonly nome: string;
  readonly tamanho: number;
  readonly raiz: Item;
  /** Todos os itens elementares, achatados, na ordem física. */
  readonly campos: ReadonlyArray<{ caminho: string; item: Item }>;
}

/**
 * Níveis que não ocupam byte:
 *   66 = RENAMES, apelido para um intervalo já existente
 *   88 = condição nomeada (VALUE), não é campo
 * Contá-los infla o tamanho do registro.
 */
const NIVEIS_SEM_ESPACO = new Set([66, 88]);

interface Sentenca {
  readonly texto: string;
  readonly linha: number;
}

/**
 * Quebra o copybook em sentenças terminadas por ponto.
 *
 * Trata a área de sequência (colunas 1 a 6) e o indicador de comentário na
 * coluna 7, que aparecem em copybook exportado direto do mainframe.
 */
function sentencas(fonte: string): Sentenca[] {
  const out: Sentenca[] = [];
  let acc = '';
  let inicio = 0;

  fonte.split(/\r?\n/).forEach((bruta, idx) => {
    let linha = bruta;

    // Formato fixo: 1 a 6 sequência, 7 indicador, 8 a 72 código. Só descarta
    // se a coluna 7 for indicador de verdade, senão um copybook em formato
    // livre teria os 7 primeiros caracteres do nome comidos.
    if (linha.length > 7 && /^[\d ]{6}[*\-/ ]/.test(linha)) {
      const indicador = linha[6];
      if (indicador === '*' || indicador === '/') return; // comentário
      linha = linha.slice(7, 72);
    }

    const semComentario = linha.replace(/^\s*\*.*$/, '');
    const t = semComentario.trim();
    if (!t) return;

    if (!acc) inicio = idx + 1;
    acc += (acc ? ' ' : '') + t;

    if (acc.endsWith('.')) {
      out.push({ texto: acc.slice(0, -1).trim(), linha: inicio });
      acc = '';
    }
  });

  if (acc.trim()) {
    throw new ErroCopybook(`sentença sem ponto final, começando na linha ${inicio}`);
  }
  return out;
}

interface Declaracao {
  nivel: number;
  nome: string;
  pic?: string | undefined;
  usage?: string | undefined;
  sign?: string | undefined;
  linha: number;
}

function declara(s: Sentenca): Declaracao | null {
  const m = /^(\d{2})\s+(\S+)(.*)$/.exec(s.texto);
  if (!m) throw new ErroCopybook(`linha ${s.linha}: não reconheci "${s.texto}"`);

  const nivel = Number(m[1]);
  const nome = m[2]!.toUpperCase();
  const resto = m[3] ?? '';

  if (NIVEIS_SEM_ESPACO.has(nivel)) return null;

  // Falhar alto é deliberado. REDEFINES e OCCURS mudam como o deslocamento é
  // calculado; aceitá-los sem implementar produziria um layout errado que
  // decodifica sem reclamar, que é o pior resultado possível aqui.
  if (/\bREDEFINES\b/i.test(resto)) {
    throw new ErroCopybook(
      `linha ${s.linha}: REDEFINES ainda não é suportado. ` +
        'Ele é união sobre a mesma memória e exige decidir a interpretação fora do copybook.',
    );
  }
  if (/\bOCCURS\b/i.test(resto)) {
    throw new ErroCopybook(
      `linha ${s.linha}: OCCURS ainda não é suportado. ` +
        'Com DEPENDING ON o registro tem tamanho variável e o layout precisa ser resolvido por registro.',
    );
  }

  const pic = /\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i.exec(resto)?.[1];
  const usage = /\b(?:USAGE\s+(?:IS\s+)?)?(COMP(?:UTATIONAL)?(?:-[12345])?|PACKED-DECIMAL|BINARY|DISPLAY)\b/i.exec(
    resto,
  )?.[1];
  const sign = /\bSIGN\s+(?:IS\s+)?((?:LEADING|TRAILING)(?:\s+SEPARATE(?:\s+CHARACTER)?)?)/i.exec(
    resto,
  )?.[1];

  return { nivel, nome, pic, usage, sign, linha: s.linha };
}

/** Passo 1: árvore de níveis, sem calcular tamanho nem deslocamento. */
function arvore(decls: Declaracao[]): Item {
  if (!decls.length) throw new ErroCopybook('copybook sem nenhuma declaração');

  const raizDecl = decls[0]!;
  if (raizDecl.nivel !== 1 && raizDecl.nivel !== 77) {
    throw new ErroCopybook(
      `linha ${raizDecl.linha}: esperava nível 01 ou 77 no início, achei ${String(raizDecl.nivel).padStart(2, '0')}`,
    );
  }

  const cria = (d: Declaracao): Item => ({
    nivel: d.nivel,
    nome: d.nome,
    campo: d.pic ? parsePic(d.pic, { usage: d.usage, sign: d.sign }) : undefined,
    filhos: [],
    deslocamento: 0,
    tamanho: 0,
  });

  const raiz = cria(raizDecl);
  const pilha: Item[] = [raiz];

  for (const d of decls.slice(1)) {
    while (pilha.length > 1 && d.nivel <= pilha[pilha.length - 1]!.nivel) pilha.pop();
    const pai = pilha[pilha.length - 1]!;
    if (d.nivel <= pai.nivel) {
      throw new ErroCopybook(`linha ${d.linha}: nível ${d.nivel} não encaixa sob ${pai.nome}`);
    }
    const item = cria(d);
    pai.filhos.push(item);
    pilha.push(item);
  }
  return raiz;
}

/** Passo 2: tamanho de baixo para cima. Grupo é a soma dos filhos. */
function calculaTamanho(item: Item): number {
  if (item.filhos.length === 0) {
    if (!item.campo) {
      throw new ErroCopybook(`${item.nome} não tem PIC nem filhos: não sei o tamanho dele`);
    }
    item.tamanho = item.campo.tamanho;
    return item.tamanho;
  }
  if (item.campo) {
    throw new ErroCopybook(`${item.nome} tem PIC e filhos ao mesmo tempo`);
  }
  item.tamanho = item.filhos.reduce((soma, f) => soma + calculaTamanho(f), 0);
  return item.tamanho;
}

/** Passo 3: deslocamento de cima para baixo. */
function calculaDeslocamento(item: Item, base: number): void {
  item.deslocamento = base;
  let cursor = base;
  for (const f of item.filhos) {
    calculaDeslocamento(f, cursor);
    cursor += f.tamanho;
  }
}

function achata(
  item: Item,
  prefixo: string,
  saida: Array<{ caminho: string; item: Item }>,
): void {
  const caminho = prefixo ? `${prefixo}.${item.nome}` : item.nome;
  if (item.filhos.length === 0) saida.push({ caminho, item });
  else for (const f of item.filhos) achata(f, caminho, saida);
}

/** Interpreta um copybook e devolve o layout com tamanhos e deslocamentos. */
export function parseCopybook(fonte: string): Layout {
  const decls = sentencas(fonte)
    .map(declara)
    .filter((d): d is Declaracao => d !== null);

  const raiz = arvore(decls);
  calculaTamanho(raiz);
  calculaDeslocamento(raiz, 0);

  const campos: Array<{ caminho: string; item: Item }> = [];
  achata(raiz, '', campos);

  return { nome: raiz.nome, tamanho: raiz.tamanho, raiz, campos };
}
