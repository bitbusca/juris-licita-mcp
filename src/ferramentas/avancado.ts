import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { ehChaveDeTeste, type Config } from '../config.js';
import { AVANCADO_FORA, AVISO_TESTE, CHAVE_MALFORMADA, linkChave, semChave } from '../textos.js';
import { USER_AGENT } from '../util/http.js';
import { VERSAO } from '../versao.js';

/**
 * Modo avançado: repassa a chamada ao MCP remoto da BitBusca, perfil Empresas
 * (https://api.bitbusca.net/api/v1/mcp/empresas — sem pessoa física, credencial só no cabeçalho).
 * Toda regra de cobrança, escopo, cota e anti-clone fica do lado de lá: aqui só se repassa.
 *
 * Sem chave, a ferramenta responde (sem erro) o que faria e como obter a chave grátis.
 * Os nomes e parâmetros espelham `operacoesDev()` do servidor; o nome local pode diferir do
 * remoto quando o grátis já usa o nome (ex.: buscar_editais_bitbusca → buscar_editais).
 */

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const confirmar = z
  .boolean()
  .optional()
  .describe('Ausente/false = só mostra o custo em créditos e o saldo (grátis). true = executa e cobra. Mostre o custo ao usuário antes de confirmar.');

const DICA_CONFIRMAR =
  'SEMPRE chame primeiro sem confirmar: a resposta traz o custo em créditos, o saldo e se já foi paga (grátis). Mostre o custo ao usuário e só repita com confirmar: true depois do "sim" dele.';

export interface DefAvancada {
  nome: string;
  remoto: string;
  titulo: string;
  oQueFaz: string;
  entrada: z.ZodRawShape;
  /** cria algo na conta ou cobra com confirmação: o cliente de IA deve pedir confirmação */
  somenteLeitura: boolean;
  dica?: string;
}

export const AVANCADAS: DefAvancada[] = [
  {
    nome: 'buscar_publicacoes_djen',
    remoto: 'buscar_publicacoes_djen',
    titulo: 'Publicações do DJEN (intimações)',
    oQueFaz: 'busca intimações e publicações do Diário de Justiça Eletrônico Nacional (desde 2021) por OAB, número do processo, parte, advogado ou palavras.',
    entrada: {
      oab: z.string().max(20).optional().describe('OAB, ex.: 123456/SP.'),
      processo: z.string().max(40).optional().describe('Número CNJ do processo (20 dígitos).'),
      parte: z.string().max(150).optional().describe('Nome da parte (empresa ou pessoa, como aparece na publicação).'),
      advogado: z.string().max(150).optional().describe('Nome do advogado.'),
      palavras: z.string().max(300).optional().describe('Palavras no texto (aceita "frase", OR e -exclusão).'),
      tribunais: z.string().max(400).optional().describe('Siglas separadas por vírgula (ex.: TJSP,TRT2).'),
      de: dataIso.optional().describe('Data inicial (AAAA-MM-DD).'),
      ate: dataIso.optional().describe('Data final (AAAA-MM-DD).'),
      cursor: z.string().max(40).optional().describe('"proximoCursor" da resposta anterior.'),
      limite: z.number().int().min(1).max(50).optional().describe('Itens por página (padrão 20).'),
    },
    somenteLeitura: true,
    dica: 'Use ler_publicacao(id, data) para o texto completo, ficha_processo(numero) para os movimentos e calcular_prazo (grátis; evento "djen" com a data de disponibilização, campo "data") para o vencimento.',
  },
  {
    nome: 'ler_publicacao',
    remoto: 'ler_publicacao',
    titulo: 'Texto integral da publicação',
    oQueFaz: 'traz o texto completo de uma publicação do DJEN, com partes e advogados.',
    entrada: {
      id: z.string().min(1).max(40).describe('Id da publicação (campo "id" da busca).'),
      data: dataIso.optional().describe('Data da publicação (campo "data" da busca).'),
      parte: z.number().int().min(1).max(100).optional().describe('Parte do texto, quando a resposta anterior trouxer paginacao.continua = true.'),
    },
    somenteLeitura: true,
  },
  {
    nome: 'ficha_processo',
    remoto: 'ficha_processo',
    titulo: 'Ficha do processo',
    oQueFaz: 'mostra capa e movimentações de um processo (classe, assuntos, órgão, últimos movimentos).',
    entrada: { numero: z.string().min(15).max(40).describe('Número CNJ do processo (20 dígitos).') },
    somenteLeitura: true,
  },
  {
    nome: 'criar_monitor_djen',
    remoto: 'criar_monitor_djen',
    titulo: 'Monitorar OAB, parte ou processo no DJEN',
    oQueFaz: 'cria um monitor que avisa (por webhook) a cada publicação nova de uma OAB, parte ou processo.',
    entrada: {
      alvo: z.string().min(3).max(150).describe('OAB (123456/SP), nome da parte ou número CNJ.'),
      tipo: z.enum(['OAB', 'NOME', 'PROCESSO']).optional().describe('O que monitorar (padrão: deduzido do alvo).'),
      rotulo: z.string().max(80).optional().describe('Apelido do monitor.'),
    },
    somenteLeitura: false,
  },
  {
    nome: 'buscar_editais_bitbusca',
    remoto: 'buscar_editais',
    titulo: 'Editais abertos (PNCP e outros portais)',
    oQueFaz: 'busca editais abertos no PNCP e em outros portais, com filtros de valor e prazo; devolve o id para ler_edital e analisar_edital.',
    entrada: {
      q: z.string().max(300).optional().describe('Palavras do objeto (ex.: "merenda escolar").'),
      uf: z.string().max(400).optional().describe('UFs separadas por vírgula (ex.: MS,SP).'),
      valorMin: z.number().min(0).optional().describe('Valor estimado mínimo (R$).'),
      valorMax: z.number().min(0).optional().describe('Valor estimado máximo (R$).'),
      encerraAte: dataIso.optional().describe('Propostas encerram até (AAAA-MM-DD).'),
      ordem: z.enum(['encerramento', 'recentes', 'valor']).optional().describe('Ordenação.'),
      cursor: z.string().max(200).optional().describe('"proximoCursor" da resposta anterior.'),
      limite: z.number().int().min(1).max(50).optional().describe('Itens por página (padrão 20).'),
    },
    somenteLeitura: true,
  },
  {
    nome: 'ler_edital',
    remoto: 'ler_edital',
    titulo: 'Detalhe do edital',
    oQueFaz: 'mostra itens, documentos, datas e órgão de um edital.',
    entrada: { id: z.string().min(1).max(60).describe('Id do edital (campo "id" de buscar_editais_bitbusca).') },
    somenteLeitura: true,
  },
  {
    nome: 'analisar_edital',
    remoto: 'analisar_edital',
    titulo: 'Análise do edital pelo Bitinho (IA)',
    oQueFaz: 'lê o edital por você e devolve resumo, checklist de documentos, prazos, riscos e o que fazer, cada item com a página/trecho de onde saiu.',
    entrada: { id: z.string().min(1).max(60).describe('Id do edital (campo "id" de buscar_editais_bitbusca).'), confirmar },
    somenteLeitura: false,
    dica: DICA_CONFIRMAR,
  },
  {
    nome: 'resumo_edital',
    remoto: 'resumo_edital',
    titulo: 'Resumo curto do edital (IA)',
    oQueFaz: 'resume o edital em poucas linhas (objeto, valor, prazo, exigências principais), com a fonte de cada item.',
    entrada: { id: z.string().min(1).max(60).describe('Id do edital (campo "id" de buscar_editais_bitbusca).'), confirmar },
    somenteLeitura: false,
    dica: DICA_CONFIRMAR,
  },
  {
    nome: 'score_orgao',
    remoto: 'score_orgao',
    titulo: 'Score do órgão comprador',
    oQueFaz: 'dá a nota de 0 a 100 do órgão público (saúde fiscal e histórico de pagamento, por regra sobre dados públicos), com as razões da nota.',
    entrada: { cnpj: z.string().min(11).max(20).describe('CNPJ do órgão comprador (campo do edital).') },
    somenteLeitura: true,
  },
  {
    nome: 'ficha_advogado',
    remoto: 'ficha_advogado',
    titulo: 'Ficha do advogado por OAB',
    oQueFaz: 'mostra a ficha pública do advogado pela OAB (nome, inscrição, situação, cidade/UF), sem telefone, e-mail nem endereço.',
    entrada: { oab: z.string().min(3).max(30).describe('UF + número da OAB, ex.: MS12345.') },
    somenteLeitura: true,
  },
  {
    nome: 'buscar_empresas',
    remoto: 'buscar_empresas',
    titulo: 'Empresas por filtro (base CNPJ)',
    oQueFaz: 'lista empresas da base de CNPJ por UF, município, bairro, CNAE, porte e data de abertura (sem sócios).',
    entrada: {
      uf: z.string().length(2).optional().describe('UF (ex.: MS).'),
      municipio: z.string().max(120).optional().describe('Município (nome ou código IBGE).'),
      bairro: z.string().max(120).optional().describe('Bairro.'),
      cnae: z.string().max(400).optional().describe('CNAE(s), separados por vírgula.'),
      aberturaDias: z.number().int().min(1).max(3650).optional().describe('Abertas nos últimos N dias.'),
      porte: z.string().max(40).optional().describe('Porte (ME, EPP, DEMAIS).'),
      somenteAtivas: z.boolean().optional().describe('Só situação ATIVA.'),
      page: z.number().int().min(0).max(20).optional().describe('Página (começa em 0).'),
      pageSize: z.number().int().min(1).max(100).optional().describe('Linhas por página (padrão 25).'),
    },
    somenteLeitura: true,
  },
  {
    nome: 'cidades_imovel',
    remoto: 'cidades_imovel',
    titulo: 'Cidades com cadastro de imóveis',
    oQueFaz: 'lista as cidades com cadastro imobiliário disponível (cobertura parcial do país).',
    entrada: {},
    somenteLeitura: true,
    dica: 'Use o campo "slug" como cidade em buscar_imovel e ficha_imovel.',
  },
  {
    nome: 'buscar_imovel',
    remoto: 'buscar_imovel',
    titulo: 'Buscar imóvel por endereço',
    oQueFaz: 'acha o lote/imóvel no cadastro municipal por endereço ou inscrição (não busca por CPF).',
    entrada: {
      cidade: z.string().min(2).max(60).describe('Slug da cidade (veja cidades_imovel), ex.: campo-grande.'),
      termo: z.string().min(2).max(120).describe('Endereço (rua e número) ou inscrição.'),
      limite: z.number().int().min(1).max(100).optional().describe('Máximo de resultados.'),
    },
    somenteLeitura: true,
  },
  {
    nome: 'ficha_imovel',
    remoto: 'ficha_imovel',
    titulo: 'Ficha do imóvel',
    oQueFaz: 'mostra a ficha do imóvel no cadastro municipal (área, uso, valor venal quando houver), sem dados do proprietário.',
    entrada: {
      cidade: z.string().min(2).max(60).describe('Slug da cidade.'),
      valor: z.string().min(1).max(60).describe('Inscrição/código do lote (vem de buscar_imovel).'),
    },
    somenteLeitura: true,
  },
  {
    nome: 'meu_saldo',
    remoto: 'meu_saldo',
    titulo: 'Plano e saldo de créditos',
    oQueFaz: 'mostra o plano, o saldo de créditos e os limites da sua chave BitBusca.',
    entrada: {},
    somenteLeitura: true,
  },
];

export function descricaoAvancada(d: DefAvancada): string {
  return [`[Avançado: exige BITBUSCA_API_KEY] ${d.oQueFaz[0].toUpperCase()}${d.oQueFaz.slice(1)}`, d.dica].filter(Boolean).join(' ');
}

export interface ResultadoFerramenta {
  [k: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const texto = (t: string, isError = false): ResultadoFerramenta => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Conexão com o MCP remoto. Injetável para teste. */
export interface ConectorRemoto {
  chamar(cfg: Config, ferramenta: string, args: Record<string, unknown>): Promise<ResultadoFerramenta>;
  temFerramenta(cfg: Config, ferramenta: string): Promise<boolean>;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function criarConectorRemoto(): ConectorRemoto {
  const clientes = new Map<string, Promise<Client>>();
  const listas = new Map<string, { nomes: Set<string>; ate: number }>();

  const conectar = (cfg: Config): Promise<Client> => {
    const k = `${cfg.mcpUrl}|${hash(cfg.chave ?? '')}`;
    let p = clientes.get(k);
    if (!p) {
      p = (async () => {
        const c = new Client({ name: 'juris-licita-mcp', version: VERSAO });
        const t = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${cfg.chave}`, 'User-Agent': USER_AGENT } },
        });
        await c.connect(t);
        return c;
      })();
      p.catch(() => clientes.delete(k));
      clientes.set(k, p);
    }
    return p;
  };
  const esquecer = (cfg: Config) => clientes.delete(`${cfg.mcpUrl}|${hash(cfg.chave ?? '')}`);

  return {
    async chamar(cfg, ferramenta, args) {
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        try {
          const c = await conectar(cfg);
          const r = (await c.callTool({ name: ferramenta, arguments: args })) as ResultadoFerramenta;
          const partes = (Array.isArray(r.content) ? r.content : []).filter((x: any) => x?.type === 'text') as { type: 'text'; text: string }[];
          return { content: partes.length ? partes : [{ type: 'text', text: '(sem conteúdo)' }], ...(r.isError ? { isError: true } : {}) };
        } catch (e: any) {
          esquecer(cfg);
          // StreamableHTTPError traz o status HTTP em `code`
          const status = typeof e?.code === 'number' ? e.code : 0;
          if (status === 401 || /unauthori[sz]ed|invalid_token/i.test(String(e?.message ?? ''))) {
            return texto(`A chave BITBUSCA_API_KEY foi recusada (inválida, revogada ou vencida). Gere outra em ${linkChave('chave-recusada')}`, true);
          }
          if (status === 403) return texto('Sua chave não tem acesso a esta ferramenta no plano atual (veja as permissões da chave no painel).', true);
          if (tentativa === 1) return texto(AVANCADO_FORA, true);
        }
      }
      return texto(AVANCADO_FORA, true);
    },
    async temFerramenta(cfg, ferramenta) {
      const k = `${cfg.mcpUrl}|${hash(cfg.chave ?? '')}`;
      const salvo = listas.get(k);
      if (salvo && salvo.ate > Date.now()) return salvo.nomes.has(ferramenta);
      try {
        const c = await conectar(cfg);
        const nomes = new Set<string>();
        let cursor: string | undefined;
        do {
          const r = await c.listTools(cursor ? { cursor } : undefined);
          for (const t of r.tools) nomes.add(t.name);
          cursor = r.nextCursor;
        } while (cursor);
        listas.set(k, { nomes, ate: Date.now() + 3600_000 });
        return nomes.has(ferramenta);
      } catch {
        esquecer(cfg);
        return true; // sem a lista, tenta a chamada e deixa o remoto responder
      }
    },
  };
}

/** Executa uma ferramenta avançada (ou explica como liberar). */
export async function executarAvancada(
  def: DefAvancada,
  args: Record<string, unknown>,
  cfg: Config,
  remoto: ConectorRemoto,
): Promise<ResultadoFerramenta> {
  if (cfg.chaveMalformada) return texto(CHAVE_MALFORMADA);
  if (!cfg.chave) return texto(semChave(def.nome, def.oQueFaz));
  if (def.remoto === 'score_orgao' && !(await remoto.temFerramenta(cfg, def.remoto))) {
    return texto(
      [
        'O Score do órgão ainda não está disponível pela API (só na tela de Licitações da BitBusca).',
        'Ele entra no modo avançado assim que a BitBusca publicar a ferramenta no MCP: nada a mudar do seu lado.',
        `Enquanto isso, veja em https://bitbusca.net/licitacoes?utm_source=github&utm_medium=juris-licita-mcp&utm_content=score_orgao`,
      ].join('\n'),
    );
  }
  // tira chaves vazias (o remoto valida o resto)
  const limpos = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== ''));
  const r = await remoto.chamar(cfg, def.remoto, limpos);
  if (ehChaveDeTeste(cfg.chave) && !r.isError) r.content.unshift({ type: 'text', text: AVISO_TESTE });
  return r;
}
