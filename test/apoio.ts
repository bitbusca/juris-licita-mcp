import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AmbienteHttp } from '../src/util/http.js';

/** Lê uma fixture de test/fixtures (os testes compilados ficam em .teste/test). */
export function fixture<T = any>(nome: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../test/fixtures/${nome}`, import.meta.url)), 'utf8')) as T;
}

export interface Chamada {
  url: string;
  headers: Record<string, string>;
}

/** Ambiente sem rede: `responder` decide a resposta por URL; esperas não esperam. */
export function ambienteFalso(responder: (url: string, n: number) => Response | Promise<Response>, agora = Date.parse('2026-11-05T15:00:00Z')) {
  const chamadas: Chamada[] = [];
  const esperas: number[] = [];
  let relogio = agora;
  const amb: AmbienteHttp = {
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
      chamadas.push({ url, headers });
      return responder(url, chamadas.length);
    },
    esperar: async (ms) => {
      esperas.push(ms);
      relogio += ms;
    },
    agora: () => relogio,
  };
  return { amb, chamadas, esperas };
}

export const jsonResp = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
