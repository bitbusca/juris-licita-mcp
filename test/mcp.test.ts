/**
 * Testes de ponta a ponta do protocolo: cliente MCP real conversando com o servidor (memória) e o
 * proxy do modo avançado contra um MCP remoto FALSO em HTTP local (nada vai para a internet).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { lerConfig, type Config } from '../src/config.js';
import { AVANCADAS, criarConectorRemoto, type ConectorRemoto } from '../src/ferramentas/avancado.js';
import { criarDependencias, criarServidor, type Dependencias } from '../src/servidor.js';
import { ambienteFalso, fixture, jsonResp } from './apoio.js';

const CHAVE_TESTE = `bk_test_${'c3'.repeat(24)}`;
const CHAVE_LIVE = `bk_live_${'d4'.repeat(24)}`;

async function conectar(cfg: Config, deps: Dependencias) {
  const server = criarServidor(cfg, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textoDe = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

function depsSemRede(remoto?: ConectorRemoto): Dependencias {
  const { amb } = ambienteFalso((url) => {
    if (url.includes('pncp.gov.br')) return jsonResp(fixture('pncp-busca.json'));
    return jsonResp({ statusCode: 404 }, 404);
  });
  const d = criarDependencias(amb);
  return { ...d, remoto: remoto ?? d.remoto };
}

describe('servidor MCP (cliente real em memória)', () => {
  test('lista grátis e avançadas, com anotações', async () => {
    const c = await conectar(lerConfig({}), depsSemRede());
    const { tools } = await c.listTools();
    const nomes = tools.map((t) => t.name);
    for (const n of ['calcular_prazo', 'prazos_da_lei', 'feriados', 'contar_dias_uteis', 'somar_dias_uteis', 'tribunais_cobertos', 'validar_documento', 'indice_economico', 'corrigir_valor', 'editais_abertos', 'consultar_cep', 'consultar_cnpj', 'como_ativar_avancado']) {
      assert.ok(nomes.includes(n), `falta ${n}`);
    }
    for (const d of AVANCADAS) assert.ok(nomes.includes(d.nome), `falta avançada ${d.nome}`);
    assert.equal(new Set(nomes).size, nomes.length, 'nomes únicos');
    const validar = tools.find((t) => t.name === 'validar_documento')!;
    assert.equal(validar.annotations?.readOnlyHint, true);
    assert.equal(validar.annotations?.openWorldHint, false);
    const analisar = tools.find((t) => t.name === 'analisar_edital')!;
    assert.equal(analisar.annotations?.readOnlyHint, false, 'cobra: o app de IA deve pedir confirmação');
    assert.match(analisar.description!, /^\[Avançado: exige BITBUSCA_API_KEY\]/);
    assert.ok(analisar.inputSchema.properties && 'confirmar' in analisar.inputSchema.properties);
    await c.close();
  });

  test('validar_documento pelo protocolo', async () => {
    const c = await conectar(lerConfig({}), depsSemRede());
    const r = await c.callTool({ name: 'validar_documento', arguments: { documento: '12.ABC.345/01DE-35' } });
    const j = JSON.parse(textoDe(r));
    assert.equal(j.valido, true);
    assert.equal(j.tipo, 'cnpj');
    await c.close();
  });

  test('somar_dias_uteis e editais_abertos pelo protocolo', async () => {
    const c = await conectar(lerConfig({}), depsSemRede());
    const s = JSON.parse(textoDe(await c.callTool({ name: 'somar_dias_uteis', arguments: { data: '24/12/2026', dias: 1 } })));
    assert.equal(s.resultado, '2026-12-28');
    const e = JSON.parse(textoDe(await c.callTool({ name: 'editais_abertos', arguments: { uf: 'MS' } })));
    assert.ok(Array.isArray(e.itens));
    await c.close();
  });

  test('calcular_prazo pelo protocolo (DJEN, TJMS/Campo Grande)', async () => {
    const c = await conectar(lerConfig({}), depsSemRede());
    const r = await c.callTool({ name: 'calcular_prazo', arguments: { inicio: '2026-11-13', dias: 15, tribunal: 'TJMS', comarca: 'Campo Grande', evento: 'djen' } });
    assert.notEqual(r.isError, true);
    const j = JSON.parse(textoDe(r));
    assert.equal(j.vencimento, '2026-12-10');
    const t = await c.callTool({ name: 'calcular_prazo', arguments: { inicio: '31/02/2026', dias: 5 } });
    assert.equal(t.isError, true);
    assert.match(textoDe(t), /data inválida/);
    await c.close();
  });

  test('erro de entrada vira isError com texto simples', async () => {
    const c = await conectar(lerConfig({}), depsSemRede());
    const r = await c.callTool({ name: 'contar_dias_uteis', arguments: { de: 'ontem', ate: '2026-01-01' } });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /Datas inválidas/);
    await c.close();
  });

  test('avançada sem chave: explica o que faz e manda para a chave grátis com UTM', async () => {
    let chamou = false;
    const remoto: ConectorRemoto = {
      chamar: async () => ((chamou = true), { content: [] }),
      temFerramenta: async () => true,
    };
    const c = await conectar(lerConfig({}), depsSemRede(remoto));
    const r = await c.callTool({ name: 'buscar_publicacoes_djen', arguments: { oab: '123456/SP' } });
    assert.notEqual(r.isError, true);
    const t = textoDe(r);
    assert.match(t, /modo avançado/);
    assert.match(t, /Diário de Justiça Eletrônico Nacional/);
    assert.match(t, /https:\/\/bitbusca\.net\/desenvolvedor\?utm_source=github&utm_medium=juris-licita-mcp&utm_content=buscar_publicacoes_djen/);
    assert.equal(chamou, false);
    await c.close();
  });

  test('chave malformada: avisa sem chamar o remoto', async () => {
    const c = await conectar(lerConfig({ BITBUSCA_API_KEY: 'minha-chave' }), depsSemRede());
    const r = await c.callTool({ name: 'meu_saldo', arguments: {} });
    assert.match(textoDe(r), /não parece uma chave da BitBusca/);
    await c.close();
  });

  test('avançada com chave: repassa com o nome remoto e marca dados fictícios na chave de teste', async () => {
    const chamadas: { ferramenta: string; args: unknown; chave?: string }[] = [];
    const remoto: ConectorRemoto = {
      chamar: async (cfg, ferramenta, args) => {
        chamadas.push({ ferramenta, args, chave: cfg.chave });
        return { content: [{ type: 'text', text: '{"itens":[]}' }] };
      },
      temFerramenta: async () => true,
    };
    const c = await conectar(lerConfig({ BITBUSCA_API_KEY: CHAVE_TESTE }), depsSemRede(remoto));
    const r = await c.callTool({ name: 'buscar_editais_bitbusca', arguments: { q: 'merenda', uf: 'MS' } });
    assert.deepEqual(chamadas, [{ ferramenta: 'buscar_editais', args: { q: 'merenda', uf: 'MS' }, chave: CHAVE_TESTE }]);
    assert.match(textoDe(r), /DADOS FICTÍCIOS/);
    await c.close();
  });

  test('score_orgao: se o remoto ainda não tem a ferramenta, diz isso sem cobrar nada', async () => {
    let chamou = false;
    const remoto: ConectorRemoto = {
      chamar: async () => ((chamou = true), { content: [] }),
      temFerramenta: async (_cfg, nome) => nome !== 'score_orgao',
    };
    const c = await conectar(lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE }), depsSemRede(remoto));
    const r = await c.callTool({ name: 'score_orgao', arguments: { cnpj: '00394460005887' } });
    assert.match(textoDe(r), /ainda não está disponível pela API/);
    assert.equal(chamou, false);
    await c.close();
  });
});

describe('proxy do modo avançado contra um MCP remoto falso (HTTP local)', () => {
  let http: Server;
  let url = '';
  const vistos: { auth?: string; ua?: string; ferramenta?: string; args?: unknown }[] = [];

  before(async () => {
    http = createServer(async (req, res) => {
      const partes: Buffer[] = [];
      for await (const p of req) partes.push(p as Buffer);
      const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || 'null');
      const visto = { auth: req.headers.authorization, ua: req.headers['user-agent'] as string };
      if (req.headers.authorization !== `Bearer ${CHAVE_LIVE}`) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        res.end(JSON.stringify({ error: 'Token inválido.', code: 'TOKEN_INVALIDO' }));
        return;
      }
      const s = new McpServer({ name: 'remoto-falso', version: '1.0.0' });
      s.registerTool('buscar_editais', { inputSchema: { q: z.string().optional() } }, async (a) => {
        vistos.push({ ...visto, ferramenta: 'buscar_editais', args: a });
        return { content: [{ type: 'text', text: JSON.stringify({ itens: [{ id: 'ed_1', objeto: `edital de ${a.q}` }] }) }] };
      });
      s.registerTool('analisar_edital', { inputSchema: { id: z.string(), confirmar: z.boolean().optional() } }, async (a) => ({
        content: [{ type: 'text', text: JSON.stringify(a.confirmar ? { status: 'pronto' } : { estimativa: true, custo: 3, saldoRestante: 47 }) }],
      }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        t.close().catch(() => undefined);
        s.close().catch(() => undefined);
      });
      await s.connect(t);
      await t.handleRequest(req, res, corpo);
    });
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  after(() => {
    http.closeAllConnections();
    return new Promise<void>((ok) => http.close(() => ok()));
  });

  test('repassa ferramenta, argumentos, chave no cabeçalho e User-Agent', async () => {
    const remoto = criarConectorRemoto();
    const cfg = lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE, BITBUSCA_MCP_URL: url });
    const r = await remoto.chamar(cfg, 'buscar_editais', { q: 'merenda' });
    assert.notEqual(r.isError, true);
    assert.match(r.content[0].text, /edital de merenda/);
    const v = vistos.at(-1)!;
    assert.equal(v.auth, `Bearer ${CHAVE_LIVE}`);
    assert.match(v.ua!, /^juris-licita-mcp\//);
    assert.deepEqual(v.args, { q: 'merenda' });
    assert.equal(await remoto.temFerramenta(cfg, 'buscar_editais'), true);
    assert.equal(await remoto.temFerramenta(cfg, 'score_orgao'), false);
  });

  test('padrão de custo: sem confirmar devolve a estimativa do remoto', async () => {
    const remoto = criarConectorRemoto();
    const cfg = lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE, BITBUSCA_MCP_URL: url });
    const r = await remoto.chamar(cfg, 'analisar_edital', { id: 'ed_1' });
    assert.deepEqual(JSON.parse(r.content[0].text), { estimativa: true, custo: 3, saldoRestante: 47 });
  });

  test('chave recusada pelo remoto: mensagem amigável, sem detalhe técnico', async () => {
    const remoto = criarConectorRemoto();
    const cfg = lerConfig({ BITBUSCA_API_KEY: `bk_live_${'e5'.repeat(24)}`, BITBUSCA_MCP_URL: url });
    const r = await remoto.chamar(cfg, 'buscar_editais', { q: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /foi recusada/);
  });

  test('remoto fora do ar: "nenhum crédito foi gasto"', async () => {
    const remoto = criarConectorRemoto();
    const cfg = lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE, BITBUSCA_MCP_URL: 'http://127.0.0.1:1/mcp' });
    const r = await remoto.chamar(cfg, 'buscar_editais', { q: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Nenhum crédito foi gasto/);
  });
});
