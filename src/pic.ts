/**
 * Interpretação da cláusula PICTURE do COBOL.
 *
 * O ponto central: PIC não descreve um valor, descreve quantos bytes o campo
 * ocupa e como interpretá-los. Errar o tamanho não gera exceção, desloca todos
 * os campos seguintes do registro.
 */

/** Como o campo está armazenado em bytes. */
export type Usage =
  | 'DISPLAY' // um byte por dígito ou caractere
  | 'COMP-3' // decimal empacotado, dois dígitos por byte
  | 'BINARY' // inteiro binário big-endian
  | 'COMP-1' // ponto flutuante 4 bytes
  | 'COMP-2'; // ponto flutuante 8 bytes

export type Categoria = 'alfanumerico' | 'numerico';

export interface CampoPic {
  readonly pic: string;
  readonly categoria: Categoria;
  readonly usage: Usage;
  /** Total de dígitos, incluindo os que ficam depois da vírgula implícita. */
  readonly digitos: number;
  /** Casas depois do V. `PIC 9(5)V99` tem escala 2. */
  readonly escala: number;
  readonly assinado: boolean;
  /** Onde o sinal fica, quando assinado e em DISPLAY. */
  readonly posicaoSinal: 'trailing' | 'leading' | 'separate-trailing' | 'separate-leading';
  readonly tamanho: number;
}

export class ErroPic extends Error {}

/**
 * Expande a notação de repetição do PIC.
 *
 * `9(3)` -> `999`, `XX` -> `XX`. As duas formas coexistem no mesmo PIC,
 * e `S9(3)V9(2)` é equivalente a `S999V99`.
 */
function expandir(corpo: string): string {
  let saida = '';
  let i = 0;
  while (i < corpo.length) {
    const ch = corpo[i]!;
    const abre = corpo[i + 1] === '(';
    if (!abre) {
      saida += ch;
      i += 1;
      continue;
    }
    const fecha = corpo.indexOf(')', i + 2);
    if (fecha === -1) throw new ErroPic(`parêntese não fechado em "${corpo}"`);
    const bruto = corpo.slice(i + 2, fecha);
    if (!/^\d+$/.test(bruto)) throw new ErroPic(`repetição inválida "${bruto}" em "${corpo}"`);
    const n = Number(bruto);
    if (n < 1) throw new ErroPic(`repetição precisa ser maior que zero em "${corpo}"`);
    saida += ch.repeat(n);
    i = fecha + 1;
  }
  return saida;
}

/** Bytes de um inteiro BINARY (COMP), pela faixa de dígitos do padrão COBOL. */
function tamanhoBinario(digitos: number): number {
  if (digitos <= 4) return 2;
  if (digitos <= 9) return 4;
  if (digitos <= 18) return 8;
  throw new ErroPic(`BINARY com ${digitos} dígitos passa do limite de 18`);
}

/** Bytes de um campo COMP-3. O +1 é o nibble de sinal. */
export function tamanhoComp3(digitos: number): number {
  return Math.ceil((digitos + 1) / 2);
}

function normalizaUsage(bruto: string | undefined): Usage {
  if (!bruto) return 'DISPLAY';
  const u = bruto.toUpperCase().replace(/\s+/g, ' ').trim();
  switch (u) {
    case 'DISPLAY':
      return 'DISPLAY';
    case 'COMP-3':
    case 'COMPUTATIONAL-3':
    case 'PACKED-DECIMAL':
      return 'COMP-3';
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
    case 'COMPUTATIONAL':
    case 'COMPUTATIONAL-4':
    case 'BINARY':
      return 'BINARY';
    case 'COMP-1':
    case 'COMPUTATIONAL-1':
      return 'COMP-1';
    case 'COMP-2':
    case 'COMPUTATIONAL-2':
      return 'COMP-2';
    default:
      throw new ErroPic(`USAGE desconhecido: "${bruto}"`);
  }
}

export interface OpcoesPic {
  usage?: string | undefined;
  /** Cláusula SIGN, quando presente: "LEADING", "TRAILING SEPARATE" etc. */
  sign?: string | undefined;
}

/**
 * Interpreta uma cláusula PIC e devolve o descritor do campo.
 *
 * @param pic corpo do PIC, sem a palavra `PIC`. Ex.: `S9(5)V99`
 */
export function parsePic(pic: string, opcoes: OpcoesPic = {}): CampoPic {
  const bruto = pic.trim().replace(/\.$/, '');
  if (!bruto) throw new ErroPic('PIC vazio');

  const usage = normalizaUsage(opcoes.usage);
  const corpo = expandir(bruto.toUpperCase());

  const assinado = corpo.startsWith('S');
  const semSinal = assinado ? corpo.slice(1) : corpo;

  if (semSinal.includes('S')) throw new ErroPic(`S só pode aparecer no início: "${pic}"`);

  const alfa = /[XA]/.test(semSinal);
  const num = /[9VPZ]/.test(semSinal);

  if (alfa && num) throw new ErroPic(`PIC mistura alfanumérico e numérico: "${pic}"`);

  if (alfa) {
    if (assinado) throw new ErroPic(`S não se aplica a PIC alfanumérico: "${pic}"`);
    if (usage !== 'DISPLAY') {
      throw new ErroPic(`USAGE ${usage} não se aplica a PIC alfanumérico: "${pic}"`);
    }
    const tamanho = semSinal.length;
    return {
      pic: bruto,
      categoria: 'alfanumerico',
      usage,
      digitos: 0,
      escala: 0,
      assinado: false,
      posicaoSinal: 'trailing',
      tamanho,
    };
  }

  if (!num) throw new ErroPic(`PIC sem símbolo reconhecido: "${pic}"`);

  const vezes = (semSinal.match(/V/g) ?? []).length;
  if (vezes > 1) throw new ErroPic(`mais de um V em "${pic}"`);

  const idxV = semSinal.indexOf('V');
  const digitos = (semSinal.match(/9/g) ?? []).length;
  if (digitos === 0) throw new ErroPic(`PIC numérico sem nenhum 9: "${pic}"`);
  const escala = idxV === -1 ? 0 : (semSinal.slice(idxV + 1).match(/9/g) ?? []).length;

  const sign = (opcoes.sign ?? '').toUpperCase();
  const separado = sign.includes('SEPARATE');
  const leading = sign.includes('LEADING');
  const posicaoSinal: CampoPic['posicaoSinal'] = separado
    ? leading
      ? 'separate-leading'
      : 'separate-trailing'
    : leading
      ? 'leading'
      : 'trailing';

  if (sign && !assinado) throw new ErroPic(`cláusula SIGN sem S no PIC: "${pic}"`);
  if (sign && usage !== 'DISPLAY') {
    throw new ErroPic(`cláusula SIGN só vale para DISPLAY, não ${usage}: "${pic}"`);
  }

  let tamanho: number;
  switch (usage) {
    case 'DISPLAY':
      // O sinal na zona não gasta byte. SIGN SEPARATE gasta um byte a mais,
      // e é a exceção que faz o registro deslocar quando ignorada.
      tamanho = digitos + (assinado && separado ? 1 : 0);
      break;
    case 'COMP-3':
      tamanho = tamanhoComp3(digitos);
      break;
    case 'BINARY':
      tamanho = tamanhoBinario(digitos);
      break;
    case 'COMP-1':
      tamanho = 4;
      break;
    case 'COMP-2':
      tamanho = 8;
      break;
  }

  return {
    pic: bruto,
    categoria: 'numerico',
    usage,
    digitos,
    escala,
    assinado,
    posicaoSinal,
    tamanho,
  };
}
