import { CacheMemoria } from '../util/cache.js';
import { ErroFonte, Ritmo, pedirJson, type AmbienteHttp } from '../util/http.js';

/**
 * Editais com proposta aberta no Portal Nacional de Contratações Públicas (PNCP), pela busca
 * pública do portal (sem chave):
 *   https://pncp.gov.br/api/search/?tipos_documento=edital&status=recebendo_proposta&q=…&ufs=…&municipios=…&modalidades=…
 * Ordenada do mais recente para o mais antigo. (A lista oficial /api/consulta/v1/contratacoes/proposta
 * leva 30–40 s por página e não ordena: não serve para conversa.)
 *
 * Educação com a fonte: UMA chamada por vez, 2 s entre o fim de uma e o início da outra, recuo em
 * 429 (e o intervalo sobe), repetição rápida quando o portal derruba a conexão (acontece) e cache
 * de 10 minutos por pedido.
 */

export const MODALIDADES: Record<string, { id: number; nome: string }> = {
  leilao_eletronico: { id: 1, nome: 'Leilão - Eletrônico' },
  dialogo_competitivo: { id: 2, nome: 'Diálogo Competitivo' },
  concurso: { id: 3, nome: 'Concurso' },
  concorrencia_eletronica: { id: 4, nome: 'Concorrência - Eletrônica' },
  concorrencia_presencial: { id: 5, nome: 'Concorrência - Presencial' },
  pregao_eletronico: { id: 6, nome: 'Pregão - Eletrônico' },
  pregao_presencial: { id: 7, nome: 'Pregão - Presencial' },
  dispensa: { id: 8, nome: 'Dispensa de Licitação' },
  inexigibilidade: { id: 9, nome: 'Inexigibilidade' },
  manifestacao_interesse: { id: 10, nome: 'Manifestação de Interesse' },
  pre_qualificacao: { id: 11, nome: 'Pré-qualificação' },
  credenciamento: { id: 12, nome: 'Credenciamento' },
  leilao_presencial: { id: 13, nome: 'Leilão - Presencial' },
};
export type ModalidadeId = keyof typeof MODALIDADES;

export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

export interface FiltroEditais {
  q?: string;
  uf?: string;
  /** código IBGE de 7 dígitos */
  municipioIbge?: string;
  modalidade?: ModalidadeId;
  /** propostas encerram até (AAAA-MM-DD); filtra os itens da página */
  encerraAte?: string;
  pagina?: number;
  limite?: number;
}

export interface Edital {
  numeroControlePNCP: string;
  titulo: string | null;
  objeto: string;
  orgao: string | null;
  municipio: string | null;
  uf: string | null;
  modalidade: string | null;
  publicadoEm: string | null;
  aberturaPropostas: string | null;
  encerramentoPropostas: string | null;
  valorEstimado: number | null;
  link: string | null;
}

export interface ResultadoEditais {
  fonte: string;
  consultadoEm: string;
  filtro: FiltroEditais;
  pagina: number;
  total: number | null;
  itens: Edital[];
  proximaPagina: number | null;
  observacao?: string;
  dica: string;
}

const BASE = 'https://pncp.gov.br';
const ROTULO_FONTE = 'Portal Nacional de Contratações Públicas (pncp.gov.br), busca pública';

/** "03659166002156-1-000135/2026" → link da página do edital no portal */
export function linkDoControle(numero: string | null | undefined): string | null {
  const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(String(numero ?? ''));
  return m ? `${BASE}/app/editais/${m[1]}/${m[3]}/${Number(m[2])}` : null;
}

const texto = (v: unknown, max = 600): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};
const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Item da busca do portal → Edital (só os campos que interessam; nada de pessoa física). */
export function deItemBusca(i: any): Edital {
  const controle = String(i?.numero_controle_pncp ?? '');
  return {
    numeroControlePNCP: controle,
    titulo: texto(i?.title, 120),
    objeto: texto(i?.description) ?? texto(i?.title) ?? '(sem descrição)',
    orgao: texto(i?.orgao_nome, 200),
    municipio: texto(i?.municipio_nome, 120),
    uf: texto(i?.uf, 2),
    modalidade: texto(i?.modalidade_licitacao_nome, 80),
    publicadoEm: texto(i?.data_publicacao_pncp, 19),
    aberturaPropostas: texto(i?.data_inicio_vigencia, 40),
    encerramentoPropostas: texto(i?.data_fim_vigencia, 40),
    valorEstimado: numero(i?.valor_global),
    link: linkDoControle(controle),
  };
}

export interface ClientePncp {
  buscar(f: FiltroEditais, agoraIsoLocal: string): Promise<ResultadoEditais>;
}

export function criarClientePncp(amb: AmbienteHttp): ClientePncp {
  const cache = new CacheMemoria<{ total: number | null; itens: Edital[] }>(200, amb.agora);
  const ritmo = new Ritmo(2000, amb);

  return {
    async buscar(f, agoraIsoLocal) {
      const pagina = Math.max(1, Math.min(f.pagina ?? 1, 50));
      const limite = Math.max(1, Math.min(f.limite ?? 10, 20));
      if (f.uf && !(UFS as readonly string[]).includes(f.uf)) throw new ErroFonte('UF inválida (use a sigla, ex.: MS).', 400, 'ENTRADA');
      if (f.municipioIbge && !/^\d{7}$/.test(f.municipioIbge)) throw new ErroFonte('Município: use o código IBGE de 7 dígitos.', 400, 'ENTRADA');
      if (f.modalidade && !MODALIDADES[f.modalidade]) throw new ErroFonte('Modalidade desconhecida.', 400, 'ENTRADA');

      const p = new URLSearchParams();
      const q = f.q?.trim();
      if (q) p.set('q', q);
      p.set('tipos_documento', 'edital');
      p.set('ordenacao', '-data');
      p.set('pagina', String(pagina));
      p.set('tam_pagina', String(limite));
      p.set('status', 'recebendo_proposta');
      if (f.uf) p.set('ufs', f.uf);
      if (f.municipioIbge) p.set('municipios', f.municipioIbge);
      if (f.modalidade) p.set('modalidades', String(MODALIDADES[f.modalidade].id));
      const url = `${BASE}/api/search/?${p}`;

      const bruto = await cache.obter(url, 10 * 60_000, async () => {
        const r = await pedirJson<any>(amb, { url, ritmo, timeoutMs: 30_000, tentativas: 4, recuos: [2000, 5000, 8000] });
        if (r.status === 204) return { total: 0, itens: [] };
        if (r.status === 400) throw new ErroFonte('O portal recusou os filtros. Confira UF, município e modalidade.', 400, 'ENTRADA');
        if (r.status !== 200 || !r.data) throw new ErroFonte('O portal de compras públicas não respondeu agora. Tente de novo em alguns minutos.', 503, 'INDISPONIVEL');
        return { total: numero(r.data.total), itens: (Array.isArray(r.data.items) ? r.data.items : []).map(deItemBusca) };
      });

      // só o que ainda recebe proposta (o índice do portal leva um tempo para tirar os encerrados)
      const agora = agoraIsoLocal.slice(0, 16);
      let itens = bruto.itens.filter((e) => !e.encerramentoPropostas || e.encerramentoPropostas.slice(0, 16) >= agora);
      if (f.encerraAte) itens = itens.filter((e) => !e.encerramentoPropostas || e.encerramentoPropostas.slice(0, 10) <= f.encerraAte!);
      const total = bruto.total;
      return {
        fonte: ROTULO_FONTE,
        consultadoEm: new Date(amb.agora()).toISOString(),
        filtro: { ...f, pagina, limite },
        pagina,
        total,
        itens,
        proximaPagina: total !== null && pagina * limite < total && pagina < 50 ? pagina + 1 : null,
        ...(f.encerraAte ? { observacao: 'O filtro "encerra até" vale para os itens desta página; peça a próxima página para ver mais.' } : {}),
        dica: 'Abra o "link" para ver o edital no portal. Para resumo, checklist de documentos e riscos lidos por IA, use as ferramentas avançadas buscar_editais_bitbusca e analisar_edital.',
      };
    },
  };
}
