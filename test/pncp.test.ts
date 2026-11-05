import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClientePncp, linkDoControle } from '../src/ferramentas/pncp.js';
import { ErroFonte } from '../src/util/http.js';
import { ambienteFalso, fixture, jsonResp } from './apoio.js';

// Recorte real da busca pública do PNCP (05/11/2026): encerramentos em 17/11 10:00 e 18/11 08:00.
const BUSCA = fixture('pncp-busca.json');

describe('PNCP (busca pública, com mock)', () => {
  test('com palavras: monta a URL da busca com UF, modalidade e status de proposta aberta', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp(BUSCA));
    const r = await criarClientePncp(amb).buscar({ q: 'merenda escolar', uf: 'MS', modalidade: 'pregao_eletronico', limite: 5 }, '2026-11-05T12:00');
    const u = new URL(chamadas[0].url);
    assert.equal(u.origin + u.pathname, 'https://pncp.gov.br/api/search/');
    assert.equal(u.searchParams.get('q'), 'merenda escolar');
    assert.equal(u.searchParams.get('ufs'), 'MS');
    assert.equal(u.searchParams.get('modalidades'), '6');
    assert.equal(u.searchParams.get('status'), 'recebendo_proposta');
    assert.equal(u.searchParams.get('tipos_documento'), 'edital');
    assert.equal(u.searchParams.get('tam_pagina'), '5');
    assert.equal(r.itens.length, 2);
    const e = r.itens[0];
    assert.equal(e.numeroControlePNCP, BUSCA.items[0].numero_controle_pncp);
    assert.equal(e.orgao, BUSCA.items[0].orgao_nome);
    assert.match(e.link!, /^https:\/\/pncp\.gov\.br\/app\/editais\/\d{14}\/\d{4}\/\d+$/);
    assert.ok(e.objeto.length > 10);
    assert.match(r.fonte, /Portal Nacional de Contratações Públicas/);
    assert.equal(r.total, BUSCA.total);
    assert.equal(r.proximaPagina, 2);
  });

  test('sem palavras e por município: não manda q, manda municipios', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp(BUSCA));
    await criarClientePncp(amb).buscar({ municipioIbge: '5002704' }, '2026-11-05T12:00');
    const u = new URL(chamadas[0].url);
    assert.equal(u.searchParams.has('q'), false);
    assert.equal(u.searchParams.get('municipios'), '5002704');
  });

  test('tira os que já encerraram e respeita "encerra até"', async () => {
    const { amb } = ambienteFalso(() => jsonResp(BUSCA));
    const c = criarClientePncp(amb);
    const depois = await c.buscar({ uf: 'MS' }, '2026-11-17T12:00');
    assert.equal(depois.itens.length, 1, 'o de 17/11 10:00 já encerrou ao meio-dia');
    const ate = await c.buscar({ uf: 'MS', encerraAte: '2026-11-17' }, '2026-11-05T12:00');
    assert.equal(ate.itens.length, 1);
    assert.ok(ate.observacao);
  });

  test('cache de 10 minutos: o mesmo pedido não volta ao portal', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp(BUSCA));
    const c = criarClientePncp(amb);
    await c.buscar({ uf: 'MS' }, '2026-11-05T12:00');
    await c.buscar({ uf: 'MS' }, '2026-11-05T12:00');
    assert.equal(chamadas.length, 1);
  });

  test('portal derruba a conexão: repete rápido e responde', async () => {
    const { amb, chamadas, esperas } = ambienteFalso((_u, n) => {
      if (n < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return jsonResp(BUSCA);
    });
    const r = await criarClientePncp(amb).buscar({ q: 'obra' }, '2026-11-05T12:00');
    assert.equal(r.itens.length, 2);
    assert.equal(chamadas.length, 3);
    assert.ok(esperas.filter((ms) => ms === 800).length >= 2, 'recuo curto em queda de conexão');
  });

  test('429 seguidos: recua, desacelera e devolve mensagem de limite', async () => {
    const { amb, chamadas, esperas } = ambienteFalso(() => jsonResp({}, 429));
    await assert.rejects(
      criarClientePncp(amb).buscar({ q: 'obra' }, '2026-11-05T12:00'),
      (e: unknown) => e instanceof ErroFonte && e.codigo === 'LIMITE' && !/429/.test(e.message),
    );
    assert.equal(chamadas.length, 4);
    assert.ok(esperas.length >= 3);
  });

  test('ritmo: duas buscas diferentes têm intervalo entre si', async () => {
    const { amb, esperas } = ambienteFalso(() => jsonResp(BUSCA));
    const c = criarClientePncp(amb);
    await c.buscar({ uf: 'MS' }, '2026-11-05T12:00');
    await c.buscar({ uf: 'SP' }, '2026-11-05T12:00');
    assert.ok(esperas.some((ms) => ms > 0 && ms <= 2000));
  });

  test('entrada inválida e link', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp(BUSCA));
    await assert.rejects(criarClientePncp(amb).buscar({ uf: 'XX' }, '2026-11-05T12:00'), /UF inválida/);
    await assert.rejects(criarClientePncp(amb).buscar({ municipioIbge: '123' }, '2026-11-05T12:00'), /IBGE/);
    assert.equal(chamadas.length, 0);
    assert.equal(linkDoControle('03659166002156-1-000135/2026'), 'https://pncp.gov.br/app/editais/03659166002156/2026/135');
    assert.equal(linkDoControle('lixo'), null);
  });
});
