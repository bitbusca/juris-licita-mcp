#!/usr/bin/env node
// Roda todos os testes compilados em .teste/test com o executor nativo (node:test).
// Lista os arquivos aqui para funcionar igual no Linux, no macOS e no Windows (sem glob do shell).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const pasta = join('.teste', 'test');
const arquivos = readdirSync(pasta)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(pasta, f));
if (!arquivos.length) {
  console.error('Nenhum teste encontrado em', pasta);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...arquivos], { stdio: 'inherit' });
process.exit(r.status ?? 1);
