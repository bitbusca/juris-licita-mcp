import { ehChaveDeTeste, type Config } from '../config.js';
import { AVISO_TESTE, linkChave } from '../textos.js';
import { CacheMemoria } from '../util/cache.js';
import { ErroFonte, pedirJson, USER_AGENT, type AmbienteHttp } from '../util/http.js';
import { VERSAO } from '../versao.js';
import { formatarCnpj, limparDocumento, validarCnpj } from './documentos.js';

/**
 * CEP e CNPJ básico pela API da BitBusca (dados públicos: endereçamento postal e cadastro da
 * Receita Federal). Ordem:
 *  1. rota ANÔNIMA com cota baixa por IP (`/publico/v1/cep|cnpj/:valor`: CEP 300/dia; CNPJ 50
 *     distintos/dia, só a base própria, sem sócio nem contato, e pausa de 24 h para consultas em
 *     sequência);
 *  2. se ela não existir, estiver no limite/pausada ou fora e houver chave, a rota da API com a
 *     chave (`/v1/cep/:cep` é grátis; `/v1/cnpj/:cnpj` custa 1 crédito; bk_test_ = fictícios);
 *  3. sem chave: diz por que não respondeu (cota do dia, pausa, fora do ar) e como liberar.
 *
 * Saída SEMPRE por lista branca de campos: nada de sócio, CPF, telefone ou e-mail. No MEI e no
 * empresário individual (a empresa é a própria pessoa), o endereço sai só com bairro/cidade/UF.
 */

export interface Cep {
  cep: string;
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  ibge: string | null;
  ddd: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface CnpjBasico {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacaoCadastral: string | null;
  dataSituacaoCadastral: string | null;
  inicioAtividade: string | null;
  naturezaJuridica: string | null;
  porte: string | null;
  capitalSocial: number | null;
  matrizOuFilial: string | null;
  cnaePrincipal: { codigo: string | null; descricao: string | null };
  endereco: {
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    municipio: string | null;
    uf: string | null;
    cep: string | null;
  };
  simples: { optanteSimples: boolean | null; mei: boolean | null } | null;
}

export interface Resposta<T> {
  dados: T;
  fonte: string;
  origem: 'anonima' | 'chave';
  ficticio: boolean;
  avisos: string[];
}

const str = (v: unknown, max = 300): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const simNao = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  const t = String(v ?? '').trim().toUpperCase();
  return t === 'S' || t === 'SIM' ? true : t === 'N' || t === 'NAO' || t === 'NÃO' ? false : null;
};
const primeiro = (o: any, ...chaves: string[]) => {
  for (const k of chaves) if (o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== '') return o[k];
  return undefined;
};
const soData = (v: unknown) => {
  const t = str(v, 40);
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
};

/** Qualquer sequência com cara de CPF (11 dígitos, com ou sem pontuação) vira máscara. */
export function mascararCpfEmTexto(t: string | null): string | null {
  if (!t) return t;
  return t.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '***.***.***-**');
}

export function normalizarCep(d: any, cep8: string): Cep {
  return {
    cep: cep8,
    logradouro: str(d?.logradouro),
    bairro: str(d?.bairro),
    cidade: str(primeiro(d, 'cidade', 'localidade', 'municipio')),
    uf: str(primeiro(d, 'uf', 'estado'), 2),
    ibge: str(d?.ibge, 7),
    ddd: num(d?.ddd),
    latitude: num(d?.latitude),
    longitude: num(d?.longitude),
  };
}

/** Empresa que é a própria pessoa: MEI ou empresário individual. */
function ehPessoaComoEmpresa(est: any, simples: any): boolean {
  if (simNao(primeiro(simples, 'opcao_mei', 'mei')) === true) return true;
  const nat = String(primeiro(est, 'natureza_juridica', 'naturezaJuridica', 'natureza_juridica_descricao') ?? '').toLowerCase();
  return /empres[aá]rio\s*\(?individual|^213-?5|^2135/.test(nat);
}

/** Aceita o formato da API (estabelecimento + simples) ou o já resumido; devolve só a lista branca. */
export function normalizarCnpj(d: any, cnpj14: string): { dados: CnpjBasico; pessoaComoEmpresa: boolean } {
  const est = d?.estabelecimento ?? d ?? {};
  const simples = d?.simples ?? est?.simples ?? null;
  const pessoa = ehPessoaComoEmpresa(est, simples);
  const end = est?.endereco ?? est;
  const dados: CnpjBasico = {
    cnpj: formatarCnpj(cnpj14),
    razaoSocial: mascararCpfEmTexto(str(primeiro(est, 'razao_social', 'razaoSocial'))),
    nomeFantasia: mascararCpfEmTexto(str(primeiro(est, 'nome_fantasia', 'nomeFantasia'))),
    situacaoCadastral: str(primeiro(est, 'situacao_cadastral', 'situacaoCadastral', 'situacao'), 40),
    dataSituacaoCadastral: soData(primeiro(est, 'data_situacao_cadastral', 'dataSituacaoCadastral')),
    inicioAtividade: soData(primeiro(est, 'data_inicio_atividade', 'inicioAtividade', 'abertura')),
    naturezaJuridica: str(primeiro(est, 'natureza_juridica', 'naturezaJuridica'), 120),
    porte: str(est?.porte, 60),
    capitalSocial: num(primeiro(est, 'capital_social', 'capitalSocial')),
    matrizOuFilial: str(primeiro(est, 'matriz_filial', 'matrizOuFilial'), 10),
    cnaePrincipal: {
      codigo: str(primeiro(est, 'cnae_fiscal_principal', 'cnaePrincipalCodigo') ?? est?.cnaePrincipal?.codigo ?? est?.cnae?.codigo, 10),
      descricao: str(primeiro(est, 'cnae_principal_descricao', 'cnaePrincipalDescricao') ?? est?.cnaePrincipal?.descricao ?? est?.cnae?.descricao, 200),
    },
    endereco: {
      logradouro: pessoa ? null : str(end?.logradouro),
      numero: pessoa ? null : str(end?.numero, 20),
      complemento: pessoa ? null : str(end?.complemento, 120),
      bairro: str(end?.bairro, 120),
      municipio: str(primeiro(end, 'municipio', 'cidade'), 120),
      uf: str(end?.uf, 2),
      cep: pessoa ? null : str(end?.cep, 9),
    },
    simples: simples
      ? { optanteSimples: simNao(primeiro(simples, 'opcao_simples', 'optanteSimples')), mei: simNao(primeiro(simples, 'opcao_mei', 'mei')) }
      : null,
  };
  return { dados, pessoaComoEmpresa: pessoa };
}

const FONTE_CEP = 'BitBusca (base de endereçamento postal)';
const FONTE_CNPJ = 'BitBusca (cadastro público de CNPJ da Receita Federal)';

/** Por que a rota anônima não respondeu (o `code` vem da API). */
export type MotivoSemChave = 'indisponivel' | 'cota' | 'pausa';

export function mensagemSemChaveCadastro(tipo: 'CEP' | 'CNPJ', motivo: MotivoSemChave = 'indisponivel'): string {
  const abertura =
    motivo === 'cota'
      ? `A cota grátis de consultas de ${tipo} sem chave desta conexão acabou por hoje (volta à meia-noite, horário de Brasília).`
      : motivo === 'pausa'
        ? `A consulta de ${tipo} sem chave foi pausada por 24 horas nesta conexão, porque saíram consultas em sequência (a consulta grátis serve para conferir empresas, não para copiar a base).`
        : `A consulta de ${tipo} sem chave não respondeu agora.`;
  return [
    abertura,
    `Com a chave grátis da BitBusca ela funciona${tipo === 'CEP' ? ' sem custo' : ' (1 crédito por CNPJ no plano; a chave de teste bk_test_ devolve dados fictícios)'}:`,
    `1. Crie a chave em ${linkChave(tipo === 'CEP' ? 'consultar_cep' : 'consultar_cnpj')}`,
    '2. Coloque-a na variável BITBUSCA_API_KEY da configuração deste servidor MCP e reinicie o app de IA.',
    tipo === 'CNPJ' ? 'Enquanto isso, validar_documento confere se o CNPJ é válido (dígito verificador, sem consultar nada).' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Mensagem neutra para cada código de erro estável da API (DESENVOLVEDORES.md, seção 4). */
function erroDaApi(status: number, corpo: any): ErroFonte {
  const code = String(corpo?.code ?? '');
  const msg = typeof corpo?.error === 'string' ? corpo.error.slice(0, 300) : '';
  if (status === 401) return new ErroFonte(`A chave BITBUSCA_API_KEY foi recusada (inválida, revogada ou vencida). Gere outra em ${linkChave('chave-recusada')}`, 401, 'ENTRADA');
  if (status === 402) return new ErroFonte('Créditos esgotados no painel da sua conta BitBusca.', 402, 'LIMITE');
  if (status === 403) return new ErroFonte(msg || 'Sua chave não tem acesso a esta consulta no plano atual.', 403, 'ENTRADA');
  if (status === 429) return new ErroFonte(msg || 'Limite de consultas atingido. Tente de novo em um minuto.', 429, 'LIMITE');
  if (status === 400) return new ErroFonte(msg || 'Valor inválido.', 400, 'ENTRADA');
  return new ErroFonte(`Consulta indisponível agora. Nenhum crédito foi gasto por esta falha.${code ? ` [${code}]` : ''}`, 503, 'INDISPONIVEL');
}

export interface ClienteCadastro {
  cep(cep: string, cfg: Config): Promise<Resposta<Cep> | { semChave: string }>;
  cnpj(cnpj: string, cfg: Config): Promise<Resposta<CnpjBasico> | { semChave: string }>;
}

export function criarClienteCadastro(amb: AmbienteHttp): ClienteCadastro {
  const cache = new CacheMemoria<unknown>(500, amb.agora);
  const cab = { 'X-Juris-Licita-Mcp': VERSAO };

  /**
   * Tenta a rota anônima. Devolve a resposta quando ela é da casa (200, 400, 404 NOT_FOUND, ou
   * 429/503 com `code`: cota, pausa ou fora); undefined = rota inexistente ou rede fora.
   */
  async function anonima(cfg: Config, caminho: string): Promise<{ status: number; data: any } | undefined> {
    try {
      // uma tentativa, lendo o corpo também no 429/503 (o `code` diz se é cota, pausa ou fora);
      // pedirJson repete e descarta o corpo nesses casos, e repetir aqui só gastaria a cota
      const resp = await amb.fetch(`${cfg.apiUrl}/publico/v1/${caminho}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...cab },
        signal: AbortSignal.timeout(15_000),
      });
      const texto = await resp.text().catch(() => '');
      let data: any = null;
      try {
        data = texto ? JSON.parse(texto) : null;
      } catch {
        data = null;
      }
      const r = { status: resp.status, data };
      if (r.status === 200) return data ? r : undefined;
      // 404 com o código da casa = "não encontrado" de verdade; 404 sem código = rota ainda não existe
      if (r.status === 404 && r.data?.code === 'NOT_FOUND') return r;
      if (r.status === 400) return r;
      if ((r.status === 429 || r.status >= 500) && typeof r.data?.code === 'string') return r;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** A rota anônima respondeu, mas não com o dado (cota do dia, pausa por sequência, fora do ar). */
  const barrada = (r: { status: number } | undefined) => !!r && (r.status === 429 || r.status >= 500);
  const motivo = (r: { status: number; data: any } | undefined): MotivoSemChave =>
    r?.status === 429 ? (r.data?.code === 'ENUMERACAO' ? 'pausa' : 'cota') : 'indisponivel';

  async function comChave(cfg: Config, caminho: string): Promise<{ status: number; data: any }> {
    const r = await pedirJson<any>(amb, {
      url: `${cfg.apiUrl}/v1/${caminho}`,
      headers: { ...cab, Authorization: `Bearer ${cfg.chave}` },
      tentativas: 2,
      timeoutMs: 30_000,
    });
    return r;
  }

  async function consultar<T>(
    tipo: 'CEP' | 'CNPJ',
    valor: string,
    cfg: Config,
    normalizar: (d: any) => { dados: T; avisos: string[] },
  ): Promise<Resposta<T> | { semChave: string }> {
    const caminho = `${tipo.toLowerCase()}/${valor}`;
    const chaveCache = `${tipo}:${valor}:${cfg.chave ? (ehChaveDeTeste(cfg.chave) ? 'teste' : 'real') : 'anon'}`;
    const salvo = cache.ler(chaveCache) as Resposta<T> | undefined;
    if (salvo) return salvo;

    const fonte = tipo === 'CEP' ? FONTE_CEP : FONTE_CNPJ;
    const a = await anonima(cfg, caminho);
    let r = a;
    let origem: Resposta<T>['origem'] = 'anonima';
    if (!r || barrada(r)) {
      if (!cfg.chave) return { semChave: mensagemSemChaveCadastro(tipo, motivo(a)) };
      r = await comChave(cfg, caminho);
      origem = 'chave';
    }
    if (r.status === 404) throw new ErroFonte(`${tipo} não encontrado na base.`, 404, 'NAO_ENCONTRADO');
    if (r.status !== 200 || !r.data) throw erroDaApi(r.status, r.data);
    const ficticio = r.data?.ambiente === 'teste' || r.data?.dados?._teste === true || r.data?._teste === true;
    const bruto = r.data?.dados ?? r.data;
    const { dados, avisos } = normalizar(bruto);
    if (ficticio) avisos.unshift(AVISO_TESTE);
    if (origem === 'chave' && tipo === 'CNPJ' && !ficticio) avisos.push('Consulta feita com a sua chave (1 crédito no plano).');
    const resp: Resposta<T> = { dados, fonte, origem, ficticio, avisos };
    cache.gravar(chaveCache, resp, (tipo === 'CEP' ? 24 : 6) * 3600_000);
    return resp;
  }

  return {
    async cep(cep, cfg) {
      const c = String(cep ?? '').replace(/\D/g, '');
      if (!/^\d{8}$/.test(c) || c === '00000000') throw new ErroFonte('O CEP tem 8 dígitos (ex.: 79002-000).', 400, 'ENTRADA');
      return consultar('CEP', c, cfg, (d) => ({ dados: normalizarCep(d, `${c.slice(0, 5)}-${c.slice(5)}`), avisos: [] }));
    },
    async cnpj(cnpj, cfg) {
      const v = validarCnpj(cnpj);
      if (!v.valido) throw new ErroFonte(`CNPJ inválido: ${v.motivo}`, 400, 'ENTRADA');
      const d = limparDocumento(cnpj);
      return consultar('CNPJ', d, cfg, (bruto) => {
        const { dados, pessoaComoEmpresa } = normalizarCnpj(bruto, d);
        const avisos = ['Sem quadro societário nem contatos: o Juris Licita MCP não entrega dados de pessoa física.'];
        if (pessoaComoEmpresa) avisos.push('MEI ou empresário individual: o endereço sai só com bairro, cidade e UF.');
        return { dados, avisos };
      });
    },
  };
}
