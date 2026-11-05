import { calendariosDisponiveis, datasMoveis, diasSemExpediente, ehDiaUtil as diaForense, sigla, slug, type Materia } from 'prazos-br';

/**
 * Feriados e dias úteis. A regra e os dados de feriado vêm do prazos-br (biblioteca irmã, MIT):
 * feriados nacionais com a lei de cada um e, nos tribunais cadastrados, o calendário forense
 * completo (portarias, feriados municipais por comarca, recesso, suspensão de 20/12 a 20/01).
 * Aqui só se escolhe o calendário e se monta a resposta.
 *
 * Calendários:
 *  - "forense" (padrão quando há tribunal): o dia conta no prazo processual daquele tribunal/comarca;
 *  - "nacional": feriados nacionais de lei (sem pontos facultativos, sem suspensão de prazos);
 *  - "bancario": os nacionais + Carnaval (segunda e terça) e Corpus Christi, dias sem expediente
 *    bancário. Bom para pagamento, boleto e prazo administrativo.
 * Datas sempre AAAA-MM-DD (dia civil, sem fuso), aritmética em UTC.
 */

export type Calendario = 'forense' | 'nacional' | 'bancario';

export interface OpcoesCalendario {
  calendario?: Calendario;
  tribunal?: string;
  comarca?: string;
  materia?: Materia;
}

const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const utc = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
};
const deUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
export const somarDias = (d: string, n: number) => deUtc(utc(d) + n * 864e5);
export const diaDaSemana = (d: string) => SEMANA[new Date(utc(d)).getUTCDay()];
const fimDeSemana = (d: string) => {
  const w = new Date(utc(d)).getUTCDay();
  return w === 0 || w === 6;
};

export function diaValido(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = RE_DIA.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1950 || y > 2199 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Aceita AAAA-MM-DD ou DD/MM/AAAA; devolve AAAA-MM-DD ou null. */
export function normalizarDia(s: string): string | null {
  const t = String(s ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : t;
  return diaValido(iso) ? iso : null;
}

/** Calendário efetivo: com tribunal e sem escolha explícita, é o forense. */
export function calendarioDe(o: OpcoesCalendario): Calendario {
  return o.calendario ?? (o.tribunal ? 'forense' : 'nacional');
}

// ── cobertura (sempre dita: o que não cobrimos, avisamos) ────────────────────

export function cobertura() {
  return calendariosDisponiveis().map((c) => ({
    tribunal: c.tribunal,
    nome: c.nome,
    uf: c.uf,
    anosConferidos: c.anosConferidos,
    comarcas: c.comarcas.length,
    comarcasComFeriadoMunicipal: c.comarcasComFeriado,
  }));
}

/** Aviso quando o tribunal/comarca/ano pedido não tem calendário próprio. null = coberto. */
export function avisoCobertura(o: OpcoesCalendario, anos: number[] = []): string | null {
  if (calendarioDe(o) !== 'forense') return null;
  const lista = calendariosDisponiveis();
  const cobertos = lista.map((c) => c.tribunal).join(', ');
  if (!o.tribunal) {
    return `Sem tribunal: contei só os feriados nacionais e a suspensão de prazos de 20/12 a 20/01. Calendários forenses completos: ${cobertos} (outros em breve).`;
  }
  const t = lista.find((c) => c.tribunal === sigla(o.tribunal!));
  if (!t) {
    return `Ainda não temos o calendário forense do ${sigla(o.tribunal)}: contei só os feriados nacionais e a suspensão de 20/12 a 20/01. O vencimento real pode ser posterior por feriado local ou portaria. Calendários completos hoje: ${cobertos} (outros em breve).`;
  }
  const avisos: string[] = [];
  if (o.comarca && !t.comarcas.some((c) => slug(c) === slug(o.comarca!))) {
    avisos.push(`Comarca "${o.comarca}" não encontrada no ${t.tribunal}: usei o calendário do tribunal, sem feriado municipal.`);
  }
  const fora = anos.filter((a) => !t.anosConferidos.includes(a));
  if (fora.length) avisos.push(`O calendário do ${t.tribunal} está conferido para ${t.anosConferidos.join(', ')}; ${fora.join(', ')} ainda não (portaria do ano pode mudar o resultado).`);
  return avisos.length ? avisos.join(' ') : null;
}

// ── feriados do ano ──────────────────────────────────────────────────────────

export interface DiaSemExpediente {
  data?: string;
  de?: string;
  ate?: string;
  nome: string;
  tipo: string;
  fonte?: string;
  origem?: string;
  diaDaSemana?: string;
}

const PONTOS_BANCARIOS = (ano: number) => {
  const m = datasMoveis(ano);
  return [
    { data: m.carnavalSegunda, nome: 'Carnaval (segunda-feira)' },
    { data: m.carnavalTerca, nome: 'Carnaval (terça-feira)' },
    { data: m.corpusChristi, nome: 'Corpus Christi' },
  ];
};

/** Feriados nacionais de lei do ano (sem suspensão de prazos nem pontos facultativos). */
function nacionais(ano: number) {
  return diasSemExpediente(ano).filter((d) => d.tipo === 'feriado' && d.origem === 'nacional');
}

/** Junta dias seguidos com o mesmo nome e tipo num período (recesso de 15 dias vira 1 linha). */
function agrupar(dias: DiaSemExpediente[]): DiaSemExpediente[] {
  // o mesmo dia pode ter duas entradas (ex.: recesso e suspensão de prazos): agrupa por nome+tipo
  const out: DiaSemExpediente[] = [];
  const abertos = new Map<string, DiaSemExpediente>();
  for (const d of dias) {
    const k = `${d.tipo}|${d.nome}`;
    const ult = abertos.get(k);
    const fim = ult?.ate ?? ult?.data;
    if (ult && fim && somarDias(fim, 1) === d.data) {
      if (ult.data) {
        ult.de = ult.data;
        delete ult.data;
        delete ult.diaDaSemana;
      }
      ult.ate = d.data;
      continue;
    }
    const novo = { ...d };
    out.push(novo);
    abertos.set(k, novo);
  }
  return out;
}

export function feriadosDoAno(ano: number, o: OpcoesCalendario = {}) {
  if (!Number.isInteger(ano) || ano < 1950 || ano > 2199) throw new RangeError('Ano inválido.');
  const cal = calendarioDe(o);
  let dias: DiaSemExpediente[];
  if (cal === 'forense') {
    dias = diasSemExpediente(ano, { tribunal: o.tribunal, comarca: o.comarca, materia: o.materia }).map((d) => ({
      data: d.data,
      nome: d.nome,
      tipo: d.tipo,
      fonte: d.fonte,
      origem: d.origem,
      diaDaSemana: diaDaSemana(d.data),
    }));
  } else {
    dias = nacionais(ano).map((d) => ({ data: d.data, nome: d.nome, tipo: 'feriado', fonte: d.fonte, diaDaSemana: diaDaSemana(d.data) }));
    if (cal === 'bancario') {
      for (const p of PONTOS_BANCARIOS(ano)) dias.push({ ...p, tipo: 'sem_expediente_bancario', fonte: 'calendário bancário nacional', diaDaSemana: diaDaSemana(p.data) });
    }
  }
  dias.sort((a, b) => (a.data! < b.data! ? -1 : a.data! > b.data! ? 1 : a.tipo.localeCompare(b.tipo)));
  const aviso = avisoCobertura(o, [ano]);
  return {
    ano,
    calendario: cal,
    tribunal: o.tribunal ? sigla(o.tribunal) : null,
    comarca: o.comarca ?? null,
    dias: agrupar(dias),
    ...(aviso ? { aviso } : {}),
    observacao:
      cal === 'forense'
        ? 'Tipos: feriado e recesso (sem expediente), ponto_facultativo, expediente_reduzido (conta no meio do prazo, mas o prazo não começa nem vence nele) e suspensao_prazos (há expediente, o prazo não corre).'
        : 'Feriados estaduais e municipais não entram neste calendário. Para o forense de um tribunal/comarca, informe o tribunal.',
  };
}

// ── dias úteis ───────────────────────────────────────────────────────────────

const cacheSemExpediente = new Map<string, Map<string, string>>();
function semExpediente(ano: number, cal: 'nacional' | 'bancario'): Map<string, string> {
  const k = `${ano}:${cal}`;
  let m = cacheSemExpediente.get(k);
  if (!m) {
    m = new Map(nacionais(ano).map((d) => [d.data, d.nome]));
    if (cal === 'bancario') for (const p of PONTOS_BANCARIOS(ano)) m.set(p.data, p.nome);
    cacheSemExpediente.set(k, m);
  }
  return m;
}

/** O dia conta? Devolve o motivo quando não conta (fim de semana não tem motivo). */
export function avaliarDia(d: string, o: OpcoesCalendario): { conta: boolean; motivo?: string; fonte?: string } {
  const cal = calendarioDe(o);
  if (cal === 'forense') {
    const r = diaForense(d, { tribunal: o.tribunal, comarca: o.comarca, materia: o.materia });
    return r.conta ? { conta: true } : { conta: false, motivo: r.motivo, ...(r.fonte ? { fonte: r.fonte } : {}) };
  }
  if (fimDeSemana(d)) return { conta: false, motivo: diaDaSemana(d) };
  const nome = semExpediente(Number(d.slice(0, 4)), cal).get(d);
  return nome ? { conta: false, motivo: nome } : { conta: true };
}

/** Limite de segurança: ~20 anos por chamada. */
export const MAX_CORRIDOS = 7300;

const anosEntre = (a: string, b: string) => {
  const out: number[] = [];
  for (let y = Number(a.slice(0, 4)); y <= Number(b.slice(0, 4)); y++) out.push(y);
  return out;
};

/**
 * Dias úteis entre duas datas: exclui o dia inicial e inclui o final ("de segunda a sexta" = 4).
 * Se `ate` < `de`, troca e conta igual.
 */
export function contarDiasUteis(de: string, ate: string, o: OpcoesCalendario = {}) {
  const [a, b] = de <= ate ? [de, ate] : [ate, de];
  const corridos = Math.round((utc(b) - utc(a)) / 864e5);
  if (corridos > MAX_CORRIDOS) throw new RangeError('Período longo demais (máximo de 20 anos por consulta).');
  let uteis = 0;
  const naoContados: { data: string; motivo: string; fonte?: string }[] = [];
  for (let d = somarDias(a, 1); d <= b; d = somarDias(d, 1)) {
    const r = avaliarDia(d, o);
    if (r.conta) uteis++;
    else if (!fimDeSemana(d) && r.motivo) naoContados.push({ data: d, motivo: r.motivo, ...(r.fonte ? { fonte: r.fonte } : {}) });
  }
  const aviso = avisoCobertura(o, anosEntre(a, b));
  return {
    de: a,
    ate: b,
    calendario: calendarioDe(o),
    tribunal: o.tribunal ? sigla(o.tribunal) : null,
    comarca: o.comarca ?? null,
    diasUteis: uteis,
    diasCorridos: corridos,
    diasNaoContadosForaFimDeSemana: agruparMotivos(naoContados),
    ...(aviso ? { aviso } : {}),
    regra: 'Exclui o dia inicial e inclui o final. Sábados, domingos e os dias sem expediente do calendário escolhido não contam.',
  };
}

/** Recesso/suspensão de 30 dias vira um período só na resposta. */
function agruparMotivos(dias: { data: string; motivo: string; fonte?: string }[]) {
  const out: { de: string; ate: string; motivo: string; fonte?: string }[] = [];
  for (const d of dias) {
    const ult = out.at(-1);
    if (ult && ult.motivo === d.motivo && d.data <= somarDias(ult.ate, 3)) {
      ult.ate = d.data;
      continue;
    }
    out.push({ de: d.data, ate: d.data, motivo: d.motivo, ...(d.fonte ? { fonte: d.fonte } : {}) });
  }
  return out.map((x) => (x.de === x.ate ? { data: x.de, motivo: x.motivo, ...(x.fonte ? { fonte: x.fonte } : {}) } : x));
}

/**
 * Anda N dias úteis a partir de uma data (negativo = para trás), sem contar a própria data.
 * 0 = a própria data se contar; senão o próximo dia que conta.
 */
export function somarDiasUteis(inicio: string, dias: number, o: OpcoesCalendario = {}) {
  if (!Number.isInteger(dias) || Math.abs(dias) > 5000) throw new RangeError('Informe um número inteiro de dias entre -5000 e 5000.');
  const passo = dias < 0 ? -1 : 1;
  const pulados: { data: string; motivo: string; fonte?: string }[] = [];
  let d = inicio;
  let guarda = 0;
  if (dias === 0) {
    while (!avaliarDia(d, o).conta) {
      d = somarDias(d, 1);
      if (++guarda > 800) throw new RangeError('Não achei dia útil nos próximos 800 dias: confira o calendário.');
    }
  } else {
    for (let falta = Math.abs(dias); falta > 0; ) {
      d = somarDias(d, passo);
      const r = avaliarDia(d, o);
      if (r.conta) falta--;
      else if (!fimDeSemana(d) && r.motivo) pulados.push({ data: d, motivo: r.motivo, ...(r.fonte ? { fonte: r.fonte } : {}) });
      if (++guarda > MAX_CORRIDOS * 2) throw new RangeError('Período longo demais.');
    }
  }
  const aviso = avisoCobertura(o, anosEntre(inicio < d ? inicio : d, inicio < d ? d : inicio));
  return {
    inicio,
    dias,
    calendario: calendarioDe(o),
    tribunal: o.tribunal ? sigla(o.tribunal) : null,
    comarca: o.comarca ?? null,
    resultado: d,
    diaDaSemana: diaDaSemana(d),
    pulados: agruparMotivos(pulados),
    ...(aviso ? { aviso } : {}),
    regra: 'Não conta o dia inicial. Fins de semana e dias sem expediente do calendário escolhido são pulados. Para prazo processual com intimação, publicação no DJEN e prorrogação, use calcular_prazo.',
  };
}
