#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { comChave, lerConfig } from './config.js';
import { criarDependencias, criarServidor } from './servidor.js';
import { VERSAO } from './versao.js';

/**
 * juris-licita-mcp
 *   npx juris-licita-mcp              stdio (Claude Desktop, Claude Code, Cursor, VS Code…)
 *   npx juris-licita-mcp --http [--port 3333] [--host 127.0.0.1]
 *                                     Streamable HTTP sem sessão em POST /mcp
 * Logs vão para stderr (stdout é do protocolo).
 */

const AJUDA = `juris-licita-mcp ${VERSAO} — prazos, feriados forenses, índices e editais para a sua IA (MCP)

Uso:
  npx juris-licita-mcp               servidor MCP por stdio (padrão)
  npx juris-licita-mcp --http        servidor MCP por HTTP em http://127.0.0.1:3333/mcp
      --port <n>                     porta (ou JURIS_LICITA_MCP_HTTP_PORT)
      --host <endereço>              interface (ou JURIS_LICITA_MCP_HTTP_HOST; padrão 127.0.0.1)
  npx juris-licita-mcp --version | --help

Variáveis:
  BITBUSCA_API_KEY   liga o modo avançado (chave grátis em https://bitbusca.net/desenvolvedor)

Sem telemetria: nada é enviado a lugar nenhum além das fontes que cada ferramenta usa.
`;

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function stdio() {
  const cfg = lerConfig();
  const server = criarServidor(cfg, criarDependencias());
  await server.connect(new StdioServerTransport());
  console.error(`[juris-licita-mcp ${VERSAO}] pronto (stdio). Modo avançado: ${cfg.chave ? 'ligado' : 'desligado (sem BITBUSCA_API_KEY)'}.`);
}

const LIMITE_CORPO = 1_000_000;

function lerCorpo(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, falha) => {
    let tam = 0;
    const partes: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      tam += c.length;
      if (tam > LIMITE_CORPO) {
        falha(new Error('corpo grande demais'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => {
      try {
        ok(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : undefined);
      } catch {
        falha(new Error('JSON inválido'));
      }
    });
    req.on('error', falha);
  });
}

function responder(res: ServerResponse, status: number, corpo: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(corpo));
}

/** Limite simples por IP (60/min) para quem expuser o modo HTTP. */
function limitador(max = 60) {
  const janela = new Map<string, { n: number; ate: number }>();
  return (ip: string): boolean => {
    const agora = Date.now();
    const j = janela.get(ip);
    if (!j || j.ate < agora) {
      if (janela.size > 10_000) janela.clear();
      janela.set(ip, { n: 1, ate: agora + 60_000 });
      return true;
    }
    j.n += 1;
    return j.n <= max;
  };
}

async function http() {
  const port = Number(argumento('--port') ?? process.env.JURIS_LICITA_MCP_HTTP_PORT ?? 3333);
  const host = argumento('--host') ?? process.env.JURIS_LICITA_MCP_HTTP_HOST ?? '127.0.0.1';
  const base = lerConfig();
  const deps = criarDependencias();
  const permitir = limitador();
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/saude' && req.method === 'GET') return responder(res, 200, { ok: true, versao: VERSAO });
    if (url.pathname !== '/mcp') return responder(res, 404, { error: 'Use POST /mcp.' });
    if (req.method !== 'POST') {
      return responder(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Servidor sem sessão: use POST.' }, id: null }, { Allow: 'POST' });
    }
    if (!permitir(req.socket.remoteAddress ?? '?')) return responder(res, 429, { error: 'Muitas chamadas. Tente em um minuto.' }, { 'Retry-After': '60' });
    let corpo: unknown;
    try {
      corpo = await lerCorpo(req);
    } catch {
      return responder(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Corpo inválido.' }, id: null });
    }
    // chave por pedido (Authorization: Bearer bk_…) vale só para este pedido; senão a do ambiente
    const auth = String(req.headers.authorization ?? '');
    const chave = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const server = criarServidor(comChave(base, chave), deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(local ? { enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] } : {}),
    });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, corpo);
    } catch {
      if (!res.headersSent) responder(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno.' }, id: null });
    }
  });
  srv.listen(port, host, () => {
    console.error(`[juris-licita-mcp ${VERSAO}] pronto em http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp (Streamable HTTP, sem sessão).`);
    if (!local) console.error('[juris-licita-mcp] atenção: ouvindo fora do loopback. Ponha um proxy com TLS na frente.');
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(AJUDA);
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${VERSAO}\n`);
    return;
  }
  if (process.argv.includes('--http')) await http();
  else await stdio();
}

main().catch((e) => {
  console.error('[juris-licita-mcp] não consegui iniciar:', e?.message ?? e);
  process.exit(1);
});
