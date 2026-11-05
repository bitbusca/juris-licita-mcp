#!/usr/bin/env node
/**
 * Chamada direta de uma ferramenta do juris-licita-mcp, sem cliente de IA no meio.
 * Abre o servidor por stdio (dist/index.js) com o SDK MCP, chama a ferramenta e imprime a resposta.
 * Foi usado para gravar o docs/demo.gif.
 *
 *   npm run build
 *   node docs/demo-chamada.mjs contar_dias_uteis '{"de":"2026-11-16","ate":"2026-11-27"}'
 *   node docs/demo-chamada.mjs calcular_prazo '{"inicio":"2026-11-13","dias":15,"tribunal":"TJMS","comarca":"Campo Grande","evento":"djen"}'
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [ferramenta = 'contar_dias_uteis', argsJson = '{"de":"2026-11-16","ate":"2026-11-27"}'] = process.argv.slice(2);
const args = JSON.parse(argsJson);

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const transporte = new StdioClientTransport({
  command: process.execPath,
  args: [join(raiz, 'dist', 'index.js')],
  stderr: 'ignore',
});
const cliente = new Client({ name: 'demo-chamada', version: '0.0.0' });

try {
  await cliente.connect(transporte);
  const srv = cliente.getServerVersion();
  console.log(`servidor: ${srv?.name} ${srv?.version} (stdio)`);
  console.log(`tools/call ${ferramenta} ${JSON.stringify(args)}\n`);
  const r = await cliente.callTool({ name: ferramenta, arguments: args });
  for (const parte of r.content ?? []) {
    if (parte.type === 'text') console.log(parte.text);
  }
  if (r.isError) process.exitCode = 1;
} finally {
  await cliente.close();
}
