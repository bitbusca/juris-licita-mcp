import { AVISO_LEGAL, calcularPrazo, type Dobro, type EventoInicial, type Materia } from 'prazos-br';
import { buscarPrazos, type PrazoCatalogo } from 'prazos-br/catalogo';
import { linkChave } from '../textos.js';

/**
 * Prazo processual com o passo a passo e a fonte de cada dia pulado, pelo prazos-br (CPC, CLT, CPP,
 * DJEN, intimação eletrônica com ciência ficta, prazo em dobro, recesso, feriados forenses por
 * tribunal e comarca). Aqui só se adapta a entrada e se enxuga a resposta para a conversa.
 */

export interface EntradaPrazo {
  inicio: string;
  dias: number;
  tipo?: 'uteis' | 'corridos' | 'clt';
  tribunal?: string;
  comarca?: string;
  evento?: EventoInicial;
  consulta?: string;
  dobro?: Dobro;
  juizado?: boolean;
  autosEletronicos?: boolean;
  materia?: Materia;
}

export function prazoProcessual(e: EntradaPrazo) {
  const r = calcularPrazo({
    inicio: e.inicio,
    dias: e.dias,
    tipo: e.tipo,
    tribunal: e.tribunal,
    comarca: e.comarca,
    evento: e.evento,
    consulta: e.consulta,
    dobro: e.dobro ?? null,
    juizado: e.juizado,
    autosEletronicos: e.autosEletronicos,
    materia: e.materia,
  });
  // os dias contados um a um e os fins de semana ficam de fora (só o total); marcos, feriados,
  // suspensões e prorrogação ficam, com a fonte
  const passos = r.passos
    .filter((p) => p.acao !== 'conta' && !(p.acao === 'pula' && /^(sábado|domingo)$/.test(p.motivo ?? '')))
    .map((p) => ({ data: p.data, diaSemana: p.diaSemana, acao: p.acao, texto: p.texto, ...(p.fonte ? { fonte: p.fonte } : {}) }));
  return {
    resumo: r.resumo,
    vencimento: r.vencimento,
    vencimentoBR: r.vencimentoBR,
    intimacao: r.intimacao,
    publicacao: r.publicacao,
    ciencia: r.ciencia,
    cienciaFicta: r.cienciaFicta,
    inicioContagem: r.inicioContagem,
    prorrogado: r.prorrogado,
    motivoProrrogacao: r.motivoProrrogacao,
    dias: r.dias,
    diasContados: r.diasContados,
    dobro: r.dobro,
    tipo: r.tipo,
    evento: r.evento,
    tribunal: r.tribunal,
    comarca: r.comarca,
    materia: r.materia,
    calendariosAplicados: r.calendarios,
    baseLegal: r.baseLegal,
    marcosEDiasPulados: passos,
    avisos: [...r.avisos, AVISO_LEGAL],
    monitorar: `Para ser avisado de cada intimação nova da sua OAB (DJEN), ative o modo avançado: ${linkChave('calcular_prazo')}`,
  };
}

export function prazosDaLei(termo: string, o: { ramo?: PrazoCatalogo['ramo']; quem?: PrazoCatalogo['quem']; limite?: number } = {}) {
  const itens = buscarPrazos(termo, { ramo: o.ramo, quem: o.quem, limite: Math.min(Math.max(o.limite ?? 10, 1), 30) });
  return {
    termo,
    total: itens.length,
    prazos: itens.map((p) => ({
      ato: p.ato,
      dias: p.dias,
      contagem: p.contagem,
      conta: p.conta,
      quem: p.quem,
      ramo: p.ramo,
      baseLegal: p.baseLegal,
      ...(p.unidadeNaLei ? { naLei: `${p.quantidadeNaLei} ${p.unidadeNaLei}` } : {}),
    })),
    dica: 'Para saber o vencimento, use calcular_prazo com a data da intimação (ou da disponibilização no DJEN) e o tribunal.',
    aviso: AVISO_LEGAL,
  };
}
