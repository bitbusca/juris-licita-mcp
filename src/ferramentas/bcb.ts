import { CacheMemoria } from '../util/cache.js';
import { ErroFonte, Ritmo, pedirJson, type AmbienteHttp } from '../util/http.js';

/**
 * Índices do Banco Central pela API pública do SGS (Sistema Gerenciador de Séries Temporais):
 *   https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=…&dataFinal=…
 * Sem chave. Cache em memória (6 h para séries mensais, 1 h para diárias) e uma chamada por vez,
 * com intervalo mínimo, para não pesar na fonte.
 *
 * Correção monetária SIMPLES (sem juros, multa ou honorários) na mesma convenção da Calculadora
 * do Cidadão do BCB: acumula a variação mensal do mês da data inicial até o mês ANTERIOR ao da
 * data final (de 01/2024 a 01/2025 = 12 índices, jan a dez/2024).
 */

export type IndiceId = 'ipca' | 'ipca_e' | 'inpc' | 'igpm' | 'selic' | 'selic_mensal' | 'selic_meta' | 'cdi' | 'dolar';

export interface DefIndice {
  codigo: number;
  nome: string;
  unidade: string;
  periodicidade: 'mensal' | 'diaria';
  /** produtor do índice (o BCB publica no SGS) */
  produtor: string;
  /** soma como variação percentual composta (correção) */
  composto: boolean;
}

export const INDICES: Record<IndiceId, DefIndice> = {
  ipca: { codigo: 433, nome: 'IPCA', unidade: '% no mês', periodicidade: 'mensal', produtor: 'IBGE', composto: true },
  ipca_e: { codigo: 10764, nome: 'IPCA-E', unidade: '% no mês', periodicidade: 'mensal', produtor: 'IBGE', composto: true },
  inpc: { codigo: 188, nome: 'INPC', unidade: '% no mês', periodicidade: 'mensal', produtor: 'IBGE', composto: true },
  // 28655 = IGP-M "variação mensal consistente com número índice", a série que a Calculadora do
  // Cidadão usa (a 189 tem só 2 casas e acumula erro de arredondamento).
  igpm: { codigo: 28655, nome: 'IGP-M', unidade: '% no mês', periodicidade: 'mensal', produtor: 'FGV', composto: true },
  selic_mensal: { codigo: 4390, nome: 'SELIC acumulada no mês', unidade: '% no mês', periodicidade: 'mensal', produtor: 'Banco Central do Brasil', composto: true },
  selic: { codigo: 11, nome: 'SELIC diária', unidade: '% ao dia', periodicidade: 'diaria', produtor: 'Banco Central do Brasil', composto: true },
  selic_meta: { codigo: 432, nome: 'Meta da SELIC (Copom)', unidade: '% ao ano', periodicidade: 'diaria', produtor: 'Banco Central do Brasil', composto: false },
  cdi: { codigo: 12, nome: 'CDI', unidade: '% ao dia', periodicidade: 'diaria', produtor: 'Banco Central do Brasil', composto: true },
  dolar: { codigo: 1, nome: 'Dólar comercial (venda)', unidade: 'R$ por US$', periodicidade: 'diaria', produtor: 'Banco Central do Brasil', composto: false },
};

export const INDICES_CORRECAO = ['ipca', 'ipca_e', 'inpc', 'igpm', 'selic'] as const;
export type IndiceCorrecao = (typeof INDICES_CORRECAO)[number];

export const rotuloFonte = (codigo: number) => `Banco Central do Brasil, SGS série ${codigo}`;

export interface Ponto {
  /** AAAA-MM (mensal) ou AAAA-MM-DD (diária) */
  periodo: string;
  valor: number;
}

/** De onde vêm os números (a real usa a API do SGS; os testes usam fixture). */
export interface FonteBcb {
  /** valores mensais de `de` a `ate` (AAAA-MM, inclusive), por mês */
  mensal(codigo: number, de: string, ate: string): Promise<Map<string, number>>;
  /** últimos n valores publicados (n ≤ 20), do mais antigo ao mais novo */
  ultimos(codigo: number, n: number): Promise<Ponto[]>;
}

// ── datas ────────────────────────────────────────────────────────────────────

export function somarMeses(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function mesesEntre(de: string, ate: string): string[] {
  const out: string[] = [];
  for (let m = de; m <= ate; m = somarMeses(m, 1)) out.push(m);
  return out;
}

const brMes = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

/** Aceita AAAA-MM, AAAA-MM-DD, MM/AAAA e DD/MM/AAAA; devolve AAAA-MM ou null. */
export function normalizarMes(s: string): string | null {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  let ano: number, mes: number;
  if (m) {
    ano = Number(m[1]);
    mes = Number(m[2]);
  } else {
    m = /^(?:(\d{2})\/)?(\d{2})\/(\d{4})$/.exec(t);
    if (!m) return null;
    ano = Number(m[3]);
    mes = Number(m[2]);
  }
  if (ano < 1980 || ano > 2199 || mes < 1 || mes > 12) return null;
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

// ── fonte real (API pública do SGS) ──────────────────────────────────────────

const BASE_SGS = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.';

interface LinhaSgs {
  data: string; // DD/MM/AAAA
  valor: string;
}

/** "01/03/2024" → "2024-03-01" */
const isoDeBr = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

export function lerRespostaSgs(linhas: unknown): Ponto[] {
  if (!Array.isArray(linhas)) return [];
  const out: Ponto[] = [];
  for (const l of linhas as LinhaSgs[]) {
    if (!l || typeof l.data !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(l.data)) continue;
    const v = Number(String(l.valor).replace(',', '.'));
    if (!Number.isFinite(v)) continue;
    out.push({ periodo: isoDeBr(l.data), valor: v });
  }
  return out;
}

export function criarFonteSgs(amb: AmbienteHttp): FonteBcb {
  const cache = new CacheMemoria<Ponto[]>(300, amb.agora);
  const ritmo = new Ritmo(300, amb);
  const buscar = async (url: string): Promise<Ponto[]> => {
    const r = await pedirJson<unknown>(amb, { url, ritmo, timeoutMs: 20_000 });
    // o SGS responde 404 quando não há valor no intervalo pedido
    if (r.status === 404 || r.status === 204) return [];
    if (r.status !== 200) throw new ErroFonte('O Banco Central não respondeu agora. Tente de novo em alguns minutos.', 503, 'INDISPONIVEL');
    return lerRespostaSgs(r.data);
  };
  return {
    async mensal(codigo, de, ate) {
      const fimMes = new Date(Date.UTC(Number(ate.slice(0, 4)), Number(ate.slice(5, 7)), 0)).getUTCDate();
      const url = `${BASE_SGS}${codigo}/dados?formato=json&dataInicial=01/${de.slice(5, 7)}/${de.slice(0, 4)}&dataFinal=${fimMes}/${ate.slice(5, 7)}/${ate.slice(0, 4)}`;
      const pts = await cache.obter(`m:${codigo}:${de}:${ate}`, 6 * 3600_000, () => buscar(url));
      return new Map(pts.map((p) => [p.periodo.slice(0, 7), p.valor]));
    },
    async ultimos(codigo, n) {
      const url = `${BASE_SGS}${codigo}/dados/ultimos/${Math.min(Math.max(1, n), 20)}?formato=json`;
      return cache.obter(`u:${codigo}:${n}`, 3600_000, () => buscar(url));
    },
  };
}

// ── consulta de índice ───────────────────────────────────────────────────────

const arred = (v: number, casas: number) => Math.round(v * 10 ** casas) / 10 ** casas;

export function acumular(valores: number[]): number {
  return valores.reduce((f, v) => f * (1 + v / 100), 1);
}

export interface ConsultaIndice {
  indice: IndiceId;
  nome: string;
  unidade: string;
  produtor: string;
  fonte: string;
  valores: Ponto[];
  ultimo: Ponto | null;
  acumuladoNoPeriodo?: string;
  acumulado12Meses?: string;
  observacao?: string;
}

export async function consultarIndice(
  fonte: FonteBcb,
  o: { indice: IndiceId; ultimos?: number; de?: string; ate?: string },
): Promise<ConsultaIndice> {
  const def = INDICES[o.indice];
  let valores: Ponto[];
  if (def.periodicidade === 'mensal' && o.de) {
    const de = normalizarMes(o.de);
    const ate = o.ate ? normalizarMes(o.ate) : de && somarMeses(de, 11);
    if (!de || !ate) throw new ErroFonte('Datas inválidas: use AAAA-MM (ex.: 2025-01).', 400, 'ENTRADA');
    if (ate < de) throw new ErroFonte('O mês final vem antes do inicial.', 400, 'ENTRADA');
    if (mesesEntre(de, ate).length > 240) throw new ErroFonte('Período longo demais (máximo de 20 anos por consulta).', 400, 'ENTRADA');
    const mapa = await fonte.mensal(def.codigo, de, ate);
    valores = [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([periodo, valor]) => ({ periodo, valor }));
  } else {
    const n = o.ultimos ?? (def.periodicidade === 'mensal' ? 12 : 5);
    valores = await fonte.ultimos(def.codigo, n);
    if (def.periodicidade === 'mensal') valores = valores.map((p) => ({ periodo: p.periodo.slice(0, 7), valor: p.valor }));
  }
  const r: ConsultaIndice = {
    indice: o.indice,
    nome: def.nome,
    unidade: def.unidade,
    produtor: def.produtor,
    fonte: rotuloFonte(def.codigo),
    valores,
    ultimo: valores.at(-1) ?? null,
  };
  if (def.periodicidade === 'mensal' && def.composto && valores.length) {
    r.acumuladoNoPeriodo = `${arred((acumular(valores.map((v) => v.valor)) - 1) * 100, 2).toFixed(2)}% (${brMes(valores[0].periodo)} a ${brMes(valores.at(-1)!.periodo)}, ${valores.length} meses)`;
    if (valores.length >= 12) {
      const ult = valores.slice(-12);
      r.acumulado12Meses = `${arred((acumular(ult.map((v) => v.valor)) - 1) * 100, 2).toFixed(2)}% (${brMes(ult[0].periodo)} a ${brMes(ult[11].periodo)})`;
    }
  }
  if (o.indice === 'selic' || o.indice === 'cdi') {
    r.observacao = 'Taxa diária. A taxa anual equivalente é ((1 + taxa/100)^252 − 1) × 100. Para a meta definida pelo Copom, use selic_meta.';
  }
  if (o.indice === 'selic_meta') {
    r.observacao = 'Meta vigente definida pelo Copom. O Banco Central publica a meta já valendo até a próxima reunião do Copom, por isso a última data pode estar no futuro.';
  }
  if (o.indice === 'dolar') r.observacao = 'Cotação de fechamento (venda) publicada pelo Banco Central em dias úteis.';
  if (!valores.length) r.observacao = 'Sem valor publicado no período pedido.';
  return r;
}

// ── correção monetária ───────────────────────────────────────────────────────

export interface Correcao {
  valorOriginal: number;
  valorCorrigido: number;
  fator: number;
  variacaoPercentual: number;
  indice: string;
  periodo: { de: string; ate: string; meses: number };
  porAno: { ano: string; meses: number; variacaoPercentual: number }[];
  regra: string;
  fonte: string;
  avisos: string[];
}

const SERIE_DA_CORRECAO: Record<IndiceCorrecao, IndiceId> = {
  ipca: 'ipca',
  ipca_e: 'ipca_e',
  inpc: 'inpc',
  igpm: 'igpm',
  selic: 'selic_mensal',
};

/**
 * Corrige um valor entre duas datas pelo índice escolhido. `hojeMes` (AAAA-MM) só serve para
 * distinguir "índice ainda não publicado" de "buraco na série".
 */
export async function corrigirValor(
  fonte: FonteBcb,
  o: { valor: number; de: string; ate: string; indice: IndiceCorrecao },
  hojeMes: string,
): Promise<Correcao> {
  if (!Number.isFinite(o.valor) || o.valor <= 0) throw new ErroFonte('Informe um valor positivo.', 400, 'ENTRADA');
  const deMes = normalizarMes(o.de);
  const ateMes = normalizarMes(o.ate);
  if (!deMes || !ateMes) throw new ErroFonte('Datas inválidas: use AAAA-MM-DD, AAAA-MM ou DD/MM/AAAA.', 400, 'ENTRADA');
  if (ateMes <= deMes) throw new ErroFonte('A data final precisa cair num mês posterior ao da data inicial.', 400, 'ENTRADA');
  const def = INDICES[SERIE_DA_CORRECAO[o.indice]];
  const ultimoMes = somarMeses(ateMes, -1);
  const meses = mesesEntre(deMes, ultimoMes);
  if (meses.length > 600) throw new ErroFonte('Período longo demais (máximo de 50 anos).', 400, 'ENTRADA');
  const mapa = await fonte.mensal(def.codigo, deMes, ultimoMes);
  const avisos: string[] = [];
  const usados: { mes: string; v: number }[] = [];
  for (let i = 0; i < meses.length; i++) {
    const m = meses[i];
    const v = mapa.get(m);
    if (v === undefined) {
      // só no fim do período e em mês recente: índice ainda não publicado
      const restoSemValor = meses.slice(i).every((x) => !mapa.has(x));
      if (restoSemValor && m >= somarMeses(hojeMes, -3)) {
        avisos.push(`${def.nome} de ${brMes(m)} em diante ainda não foi publicado: corrigido até ${usados.length ? brMes(usados.at(-1)!.mes) : '—'}.`);
        break;
      }
      throw new ErroFonte(`Não há ${def.nome} publicado para ${brMes(m)}. Confira as datas.`, 404, 'NAO_ENCONTRADO');
    }
    usados.push({ mes: m, v });
  }
  if (!usados.length) throw new ErroFonte(`Nenhum ${def.nome} publicado no período ainda.`, 404, 'NAO_ENCONTRADO');
  const fatorBruto = acumular(usados.map((u) => u.v));
  const fator = arred(fatorBruto, 7);
  const anos = new Map<string, number[]>();
  for (const u of usados) anos.set(u.mes.slice(0, 4), [...(anos.get(u.mes.slice(0, 4)) ?? []), u.v]);
  if (fator < 1) avisos.push('O índice teve deflação no período: o valor corrigido ficou menor que o original. Em cálculo judicial costuma valer o piso do valor nominal; confira o caso.');
  if (o.indice === 'selic') avisos.push('SELIC aplicada mês a mês (série acumulada no mês). Cálculos com a SELIC diária podem diferir em centavos.');
  avisos.push('Correção simples: sem juros, multa nem honorários. Confira antes de usar em documento oficial.');
  return {
    valorOriginal: o.valor,
    valorCorrigido: arred(o.valor * fator, 2),
    fator,
    variacaoPercentual: arred((fator - 1) * 100, 4),
    indice: def.nome,
    periodo: { de: usados[0].mes, ate: usados.at(-1)!.mes, meses: usados.length },
    porAno: [...anos.entries()].map(([ano, vs]) => ({ ano, meses: vs.length, variacaoPercentual: arred((acumular(vs) - 1) * 100, 4) })),
    regra: 'Acumula a variação mensal do mês da data inicial até o mês anterior ao da data final (mesma convenção da Calculadora do Cidadão do Banco Central).',
    fonte: rotuloFonte(def.codigo),
    avisos,
  };
}
