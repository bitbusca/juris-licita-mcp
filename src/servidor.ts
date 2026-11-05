import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { AVANCADAS, criarConectorRemoto, descricaoAvancada, executarAvancada, type ConectorRemoto, type ResultadoFerramenta } from './ferramentas/avancado.js';
import { consultarIndice, corrigirValor, criarFonteSgs, INDICES, INDICES_CORRECAO, type FonteBcb, type IndiceId } from './ferramentas/bcb.js';
import { criarClienteCadastro, type ClienteCadastro } from './ferramentas/cadastro.js';
import { validarDocumento } from './ferramentas/documentos.js';
import { cobertura, contarDiasUteis, feriadosDoAno, normalizarDia, somarDiasUteis } from './ferramentas/feriados.js';
import { prazoProcessual, prazosDaLei } from './ferramentas/prazos.js';
import { criarClientePncp, MODALIDADES, UFS, type ClientePncp, type ModalidadeId } from './ferramentas/pncp.js';
import { linkChave } from './textos.js';
import { agoraBrasilia } from './util/datas.js';
import { ambienteReal, ErroFonte, type AmbienteHttp } from './util/http.js';
import { VERSAO } from './versao.js';

export { lerConfig, comChave, type Config } from './config.js';
export { VERSAO } from './versao.js';

/** Tudo que fala com o mundo de fora, injetável para teste. */
export interface Dependencias {
  amb: AmbienteHttp;
  bcb: FonteBcb;
  pncp: ClientePncp;
  cadastro: ClienteCadastro;
  remoto: ConectorRemoto;
  agora: () => Date;
}

export function criarDependencias(amb: AmbienteHttp = ambienteReal()): Dependencias {
  return {
    amb,
    bcb: criarFonteSgs(amb),
    pncp: criarClientePncp(amb),
    cadastro: criarClienteCadastro(amb),
    remoto: criarConectorRemoto(),
    agora: () => new Date(amb.agora()),
  };
}

export const INSTRUCOES = [
  'Juris Licita MCP: prazos, feriados forenses, índices, editais e cadastro público para advocacia e licitações no Brasil.',
  'Grátis e sem chave: calcular_prazo (prazo processual com feriados forenses por tribunal e comarca), prazos_da_lei, feriados, contar_dias_uteis, somar_dias_uteis, tribunais_cobertos, validar_documento (só o dígito verificador; NUNCA diz de quem é o documento), indice_economico, corrigir_valor, editais_abertos, consultar_cep e consultar_cnpj.',
  'Ferramentas marcadas "[Avançado]" exigem BITBUSCA_API_KEY; sem a chave elas respondem como obter a chave grátis: repasse essa orientação ao usuário.',
  'Análises por IA (analisar_edital, resumo_edital) cobram créditos: chame primeiro sem confirmar, mostre o custo e só confirme depois do sim do usuário.',
  'Prazo é cálculo auxiliar: mostre o resumo, os dias pulados com a fonte e os avisos (inclusive quando o tribunal ou a comarca não tem calendário cadastrado), e lembre que a conferência no processo é do advogado.',
  'Cite a fonte que vem em cada resposta. Nada de dado de pessoa física: não tente descobrir de quem é um CPF.',
].join('\n');

const json = (v: unknown): ResultadoFerramenta => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const erro = (t: string): ResultadoFerramenta => ({ content: [{ type: 'text', text: t }], isError: true });

/** Envolve a ferramenta: ErroFonte vira mensagem para o usuário; o resto vira mensagem neutra. */
async function seguro(fn: () => Promise<ResultadoFerramenta> | ResultadoFerramenta): Promise<ResultadoFerramenta> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ErroFonte) return erro(e.message);
    if (e instanceof RangeError) return erro(e.message);
    if (process.env.JURIS_LICITA_MCP_DEBUG) console.error('[juris-licita-mcp]', e);
    return erro('Não consegui responder agora. Tente de novo em alguns minutos.');
  }
}

const LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const REDE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const dia = z.string().max(10).describe('Data em AAAA-MM-DD ou DD/MM/AAAA.');
const tribunal = z.string().max(12).optional().describe('Sigla do tribunal (TJMS, TRT24, TJSP, TRF3…). Veja tribunais_cobertos.');
const comarca = z.string().max(80).optional().describe('Comarca ou cidade da vara, para feriado municipal (ex.: Campo Grande).');
const materia = z.enum(['civel', 'trabalho', 'penal', 'penal_urgente', 'eleitoral']).optional().describe('Matéria (muda o recesso). Padrão: pela sigla do tribunal.');
const calendario = z
  .enum(['forense', 'nacional', 'bancario'])
  .optional()
  .describe('"forense" (padrão com tribunal): dias que contam no prazo processual daquele tribunal/comarca. "nacional" (padrão sem tribunal): feriados nacionais de lei. "bancario": nacionais + Carnaval e Corpus Christi.');

export function criarServidor(cfg: Config, deps: Dependencias = criarDependencias()): McpServer {
  const server = new McpServer(
    {
      name: 'juris-licita-mcp',
      title: 'Juris Licita MCP',
      version: VERSAO,
      websiteUrl: 'https://github.com/bitbusca/juris-licita-mcp',
    },
    { instructions: INSTRUCOES },
  );

  // ── grátis, 100% local ────────────────────────────────────────────────────
  server.registerTool(
    'validar_documento',
    {
      title: 'Validar CPF ou CNPJ',
      description:
        'Confere o dígito verificador de um CPF ou CNPJ (inclusive o CNPJ alfanumérico de 2026). Roda na sua máquina: não consulta nenhuma base, não diz se o documento existe nem de quem é. O CPF volta só mascarado.',
      inputSchema: {
        documento: z.string().min(1).max(30).describe('CPF ou CNPJ, com ou sem pontuação.'),
        tipo: z.enum(['cpf', 'cnpj']).optional().describe('Força o tipo; sem ele, decide pelo tamanho.'),
      },
      annotations: { title: 'Validar CPF ou CNPJ', ...LOCAL },
    },
    async ({ documento, tipo }) => seguro(() => json(validarDocumento(documento, tipo))),
  );

  server.registerTool(
    'calcular_prazo',
    {
      title: 'Calcular prazo processual',
      description:
        'Vencimento de prazo processual com passo a passo: CPC (dias úteis), CLT, dias corridos, publicação no DJEN (a data informada é a disponibilização), intimação eletrônica com ciência ficta de 10 dias, prazo em dobro, recesso e suspensão de 20/12 a 20/01, feriados forenses do tribunal e feriados municipais da comarca, cada dia pulado com a fonte. Calendários completos só nos tribunais de tribunais_cobertos; nos demais, avisa e usa os feriados nacionais. Cálculo local.',
      inputSchema: {
        inicio: z.string().max(10).describe('Data do evento (AAAA-MM-DD ou DD/MM/AAAA): publicação/intimação (padrão), disponibilização no DJEN ou envio da intimação eletrônica (veja "evento").'),
        dias: z.number().int().min(1).max(3650).describe('Dias do prazo, antes de dobrar (ex.: 15).'),
        tipo: z.enum(['uteis', 'corridos', 'clt']).optional().describe('uteis (CPC art. 219, padrão), clt (CLT art. 775) ou corridos (CPP art. 798; prazos materiais).'),
        tribunal,
        comarca,
        evento: z
          .enum(['publicacao', 'djen', 'intimacao_eletronica'])
          .optional()
          .describe('publicacao (padrão): a data é a publicação. djen: a data é a DISPONIBILIZAÇÃO no Diário de Justiça Eletrônico Nacional. intimacao_eletronica: a data é o ENVIO pelo sistema.'),
        consulta: z.string().max(10).optional().describe('Intimação eletrônica: data em que foi aberta, se antes dos 10 dias.'),
        dobro: z.enum(['fazenda', 'defensoria', 'mp', 'litisconsortes']).optional().describe('Prazo em dobro (CPC 183, 186, 180, 229).'),
        juizado: z.boolean().optional().describe('Processo no Juizado Especial (sem dobro para a Fazenda).'),
        autosEletronicos: z.boolean().optional().describe('Autos eletrônicos (padrão true; litisconsortes não dobram no eletrônico).'),
        materia,
      },
      annotations: { title: 'Calcular prazo processual', ...LOCAL },
    },
    async (a) => seguro(() => json(prazoProcessual(a))),
  );

  server.registerTool(
    'prazos_da_lei',
    {
      title: 'Prazos da lei (catálogo)',
      description: 'Procura no catálogo de prazos processuais (CPC, CLT, Juizados) quantos dias tem um ato, como conta e a base legal. Ex.: "contestação", "apelação", "embargos de declaração", "recurso ordinário".',
      inputSchema: {
        termo: z.string().min(2).max(120).describe('Ato processual (ex.: contestação).'),
        ramo: z.enum(['civel', 'trabalho', 'juizado']).optional().describe('Filtra pelo ramo.'),
        quem: z.enum(['parte', 'juizo']).optional().describe('Prazo da parte ou do juízo.'),
        limite: z.number().int().min(1).max(30).optional().describe('Máximo de resultados (padrão 10).'),
      },
      annotations: { title: 'Prazos da lei', ...LOCAL },
    },
    async ({ termo, ramo, quem, limite }) => seguro(() => json(prazosDaLei(termo, { ramo, quem, limite }))),
  );

  server.registerTool(
    'feriados',
    {
      title: 'Feriados e dias sem expediente',
      description:
        'Feriados do ano. Sem tribunal: feriados nacionais de lei (com a lei de cada um). Com tribunal (e comarca): calendário forense completo, com portarias, feriados municipais, recesso, pontos facultativos e suspensão de prazos. Cálculo local.',
      inputSchema: {
        ano: z.number().int().min(1950).max(2199).optional().describe('Ano (padrão: o atual).'),
        tribunal,
        comarca,
        calendario,
        materia,
      },
      annotations: { title: 'Feriados', ...LOCAL },
    },
    async ({ ano, tribunal: t, comarca: c, calendario: cal, materia: m }) =>
      seguro(() => json(feriadosDoAno(ano ?? agoraBrasilia(deps.agora()).ano, { tribunal: t, comarca: c, calendario: cal, materia: m }))),
  );

  server.registerTool(
    'contar_dias_uteis',
    {
      title: 'Contar dias úteis entre datas',
      description:
        'Quantos dias úteis há entre duas datas (exclui o dia inicial, inclui o final), no calendário forense de um tribunal/comarca, no nacional ou no bancário. Lista os dias que não contaram e por quê. Cálculo local.',
      inputSchema: { de: dia, ate: dia, tribunal, comarca, calendario, materia },
      annotations: { title: 'Contar dias úteis', ...LOCAL },
    },
    async ({ de, ate, tribunal: t, comarca: c, calendario: cal, materia: m }) =>
      seguro(() => {
        const a = normalizarDia(de);
        const b = normalizarDia(ate);
        if (!a || !b) return erro('Datas inválidas: use AAAA-MM-DD ou DD/MM/AAAA.');
        return json(contarDiasUteis(a, b, { tribunal: t, comarca: c, calendario: cal, materia: m }));
      }),
  );

  server.registerTool(
    'somar_dias_uteis',
    {
      title: 'Somar dias úteis a uma data',
      description:
        'Data que cai N dias úteis depois (ou antes, com N negativo) de uma data, sem contar o dia inicial, no calendário forense, nacional ou bancário. Bom para prazo interno do escritório e prazo de licitação. Para prazo processual a partir de intimação, use calcular_prazo.',
      inputSchema: {
        data: dia,
        dias: z.number().int().min(-5000).max(5000).describe('Dias úteis a somar (negativo subtrai).'),
        tribunal,
        comarca,
        calendario,
        materia,
      },
      annotations: { title: 'Somar dias úteis', ...LOCAL },
    },
    async ({ data, dias, tribunal: t, comarca: c, calendario: cal, materia: m }) =>
      seguro(() => {
        const d = normalizarDia(data);
        if (!d) return erro('Data inválida: use AAAA-MM-DD ou DD/MM/AAAA.');
        return json(somarDiasUteis(d, dias, { tribunal: t, comarca: c, calendario: cal, materia: m }));
      }),
  );

  server.registerTool(
    'tribunais_cobertos',
    {
      title: 'Tribunais com calendário forense',
      description: 'Lista os tribunais com calendário forense completo (portarias, comarcas, feriados municipais) e os anos conferidos. Nos demais, os cálculos usam só os feriados nacionais e avisam.',
      inputSchema: {},
      annotations: { title: 'Tribunais cobertos', ...LOCAL },
    },
    async () =>
      seguro(() =>
        json({
          tribunais: cobertura(),
          demais: 'Outros tribunais: feriados nacionais, recesso e suspensão de 20/12 a 20/01 (CPC art. 220). Outros calendários em breve.',
          contribuir: 'https://github.com/bitbusca/prazos-br/blob/main/CONTRIBUTING.md',
        }),
      ),
  );

  // ── grátis, fontes públicas ───────────────────────────────────────────────
  const listaIndices = (Object.keys(INDICES) as IndiceId[]).map((k) => `${k} (${INDICES[k].nome}, ${INDICES[k].unidade})`).join('; ');
  server.registerTool(
    'indice_economico',
    {
      title: 'Índices do Banco Central',
      description: `Valores oficiais publicados pelo Banco Central (API pública do SGS), com acumulado no período e em 12 meses para os índices mensais. Índices: ${listaIndices}.`,
      inputSchema: {
        indice: z.enum(Object.keys(INDICES) as [IndiceId, ...IndiceId[]]).describe('Qual índice.'),
        ultimos: z.number().int().min(1).max(20).optional().describe('Últimos N valores (padrão 12 nos mensais, 5 nos diários).'),
        de: z.string().max(10).optional().describe('Mês inicial AAAA-MM (só índices mensais).'),
        ate: z.string().max(10).optional().describe('Mês final AAAA-MM (só índices mensais; padrão: 12 meses depois do inicial).'),
      },
      annotations: { title: 'Índices do Banco Central', ...REDE },
    },
    async (a) => seguro(async () => json(await consultarIndice(deps.bcb, a))),
  );

  server.registerTool(
    'corrigir_valor',
    {
      title: 'Correção monetária',
      description:
        'Corrige um valor entre duas datas por IPCA, IPCA-E, INPC, IGP-M ou SELIC, com índices oficiais do Banco Central. Mesma convenção da Calculadora do Cidadão: do mês inicial até o mês anterior ao final. Correção simples, sem juros nem multa.',
      inputSchema: {
        valor: z.number().positive().max(1e13).describe('Valor em R$ (ex.: 1000).'),
        de: z.string().max(10).describe('Data inicial (AAAA-MM-DD, AAAA-MM ou DD/MM/AAAA).'),
        ate: z.string().max(10).optional().describe('Data final (padrão: hoje).'),
        indice: z.enum(INDICES_CORRECAO).optional().describe('ipca (padrão), ipca_e, inpc, igpm ou selic.'),
      },
      annotations: { title: 'Correção monetária', ...REDE },
    },
    async ({ valor, de, ate, indice }) =>
      seguro(async () => {
        const hoje = agoraBrasilia(deps.agora());
        const r = await corrigirValor(deps.bcb, { valor, de, ate: ate ?? hoje.dia, indice: indice ?? 'ipca' }, hoje.mes);
        return json({ ...r, calculoCompleto: `Juros, multa, honorários e memória em PDF: https://bitbusca.net/calculos?utm_source=github&utm_medium=juris-licita-mcp&utm_content=corrigir_valor` });
      }),
  );

  const modalidades = Object.keys(MODALIDADES) as [ModalidadeId, ...ModalidadeId[]];
  server.registerTool(
    'editais_abertos',
    {
      title: 'Editais abertos no PNCP',
      description:
        'Licitações com proposta aberta no Portal Nacional de Contratações Públicas (API pública do PNCP): por palavras do objeto, UF, município (código IBGE) e modalidade. Traz órgão, valor estimado, prazo e link do edital.',
      inputSchema: {
        q: z.string().max(200).optional().describe('Palavras do objeto (ex.: "merenda escolar"). Sem palavras, lista os mais recentes.'),
        uf: z.enum(UFS).optional().describe('UF (ex.: MS).'),
        municipio_ibge: z.string().regex(/^\d{7}$/).optional().describe('Código IBGE do município, 7 dígitos (ex.: 5002704 = Campo Grande).'),
        modalidade: z.enum(modalidades).optional().describe('Modalidade.'),
        encerra_ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Propostas encerram até (AAAA-MM-DD).'),
        pagina: z.number().int().min(1).max(50).optional().describe('Página (padrão 1).'),
        limite: z.number().int().min(1).max(20).optional().describe('Itens por página (padrão 10, máximo 20).'),
      },
      annotations: { title: 'Editais abertos (PNCP)', ...REDE },
    },
    async (a) =>
      seguro(async () =>
        json(
          await deps.pncp.buscar(
            { q: a.q, uf: a.uf, municipioIbge: a.municipio_ibge, modalidade: a.modalidade, encerraAte: a.encerra_ate, pagina: a.pagina, limite: a.limite },
            agoraBrasilia(deps.agora()).isoLocal,
          ),
        ),
      ),
  );

  server.registerTool(
    'consultar_cep',
    {
      title: 'Consultar CEP',
      description: 'Endereço de um CEP (logradouro, bairro, cidade, UF, código IBGE, DDD e coordenadas quando houver). Grátis, com cota diária por conexão; com BITBUSCA_API_KEY não há cota.',
      inputSchema: { cep: z.string().min(8).max(10).describe('CEP com ou sem hífen.') },
      annotations: { title: 'Consultar CEP', ...REDE },
    },
    async ({ cep }) =>
      seguro(async () => {
        const r = await deps.cadastro.cep(cep, cfg);
        return 'semChave' in r ? { content: [{ type: 'text', text: r.semChave }] } : json(r);
      }),
  );

  server.registerTool(
    'consultar_cnpj',
    {
      title: 'Consultar CNPJ (básico)',
      description:
        'Cadastro público do CNPJ na Receita Federal: razão social, nome fantasia, situação, abertura, natureza jurídica, porte, CNAE principal, endereço e Simples/MEI. Sem sócios e sem contatos. Grátis com cota diária por conexão; com BITBUSCA_API_KEY usa a sua chave (1 crédito).',
      inputSchema: { cnpj: z.string().min(14).max(20).describe('CNPJ com ou sem pontuação (aceita o alfanumérico).') },
      annotations: { title: 'Consultar CNPJ', ...REDE },
    },
    async ({ cnpj }) =>
      seguro(async () => {
        const r = await deps.cadastro.cnpj(cnpj, cfg);
        return 'semChave' in r ? { content: [{ type: 'text', text: r.semChave }] } : json(r);
      }),
  );

  // ── avançado (BITBUSCA_API_KEY) ───────────────────────────────────────────
  for (const def of AVANCADAS) {
    server.registerTool(
      def.nome,
      {
        title: def.titulo,
        description: descricaoAvancada(def),
        inputSchema: def.entrada,
        annotations: {
          title: def.titulo,
          readOnlyHint: def.somenteLeitura,
          destructiveHint: false,
          idempotentHint: def.somenteLeitura,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => seguro(() => executarAvancada(def, args, cfg, deps.remoto)),
    );
  }

  server.registerTool(
    'como_ativar_avancado',
    {
      title: 'Como ativar o modo avançado',
      description: 'Explica o que o modo avançado faz, quanto custa e como obter a chave grátis da BitBusca.',
      inputSchema: {},
      annotations: { title: 'Como ativar o modo avançado', ...LOCAL },
    },
    async () =>
      seguro(() =>
        json({
          ativo: Boolean(cfg.chave),
          chaveDeTeste: Boolean(cfg.chave && /^bk_test_/i.test(cfg.chave)),
          ferramentas: AVANCADAS.map((d) => ({ nome: d.nome, oQueFaz: d.oQueFaz })),
          comoAtivar: [
            `Crie a chave grátis em ${linkChave('como_ativar_avancado')}`,
            'Chave de teste (bk_test_): grátis, dados fictícios. Sandbox: 7 dias com créditos de cortesia. Planos mensais com créditos no painel.',
            'Coloque a chave em BITBUSCA_API_KEY na configuração do MCP e reinicie o app de IA.',
          ],
          cobranca: 'Falha técnica não cobra; "nada consta" cobra. Análises por IA mostram o custo antes de executar e só cobram com confirmar: true.',
        }),
      ),
  );

  return server;
}
