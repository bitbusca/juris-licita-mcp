/**
 * Correção monetária contra os valores da Calculadora do Cidadão do Banco Central, com os índices
 * da fixture test/fixtures/sgs-mensal.json (baixados da API pública do SGS em 02/11/2026). Os
 * mesmos casos estão conferidos no motor de cálculos da BitBusca. Sem rede.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarIndice, corrigirValor, criarFonteSgs, lerRespostaSgs, normalizarMes, type FonteBcb } from '../src/ferramentas/bcb.js';
import { ErroFonte } from '../src/util/http.js';
import { ambienteFalso, fixture, jsonResp } from './apoio.js';

const fx = fixture<{ series: Record<string, Record<string, string>> }>('sgs-mensal.json');

const FONTE: FonteBcb = {
  async mensal(codigo, de, ate) {
    const s = fx.series[String(codigo)] ?? {};
    return new Map(
      Object.entries(s)
        .filter(([m]) => m >= de && m <= ate)
        .map(([m, v]) => [m, Number(v)]),
    );
  },
  async ultimos(codigo, n) {
    const s = Object.entries(fx.series[String(codigo)] ?? {}).sort();
    return s.slice(-n).map(([m, v]) => ({ periodo: `${m}-01`, valor: Number(v) }));
  },
};
const HOJE_MES = '2026-11';

describe('correção monetária (Calculadora do Cidadão)', () => {
  test('IPCA 01/2024 a 01/2025: fator 1,0483130 e R$ 1.048,31 (12 índices, jan a dez/2024)', async () => {
    const r = await corrigirValor(FONTE, { valor: 1000, de: '2024-01-01', ate: '2025-01-01', indice: 'ipca' }, HOJE_MES);
    assert.equal(r.fator, 1.048313);
    assert.equal(r.valorCorrigido, 1048.31);
    assert.deepEqual(r.periodo, { de: '2024-01', ate: '2024-12', meses: 12 });
    assert.equal(r.fonte, 'Banco Central do Brasil, SGS série 433');
  });

  test('INPC 10/01/2023 a 20/01/2024: fator 1,0370699', async () => {
    const r = await corrigirValor(FONTE, { valor: 1000, de: '10/01/2023', ate: '2024-01-20', indice: 'inpc' }, HOJE_MES);
    assert.equal(r.fator, 1.0370699);
    assert.equal(r.valorCorrigido, 1037.07);
  });

  test('IPCA-E 15/03/2022 a 10/09/2024: fator 1,1246964', async () => {
    const r = await corrigirValor(FONTE, { valor: 1000, de: '2022-03-15', ate: '2024-09-10', indice: 'ipca_e' }, HOJE_MES);
    assert.equal(r.fator, 1.1246964);
    assert.equal(r.valorCorrigido, 1124.7);
  });

  test('IGP-M (série 28655) 05/01/2021 a 01/07/2026: fator 1,3091741', async () => {
    const r = await corrigirValor(FONTE, { valor: 1000, de: '2021-01-05', ate: '2026-07-01', indice: 'igpm' }, HOJE_MES);
    assert.equal(r.fator, 1.3091741);
    assert.equal(r.valorCorrigido, 1309.17);
    assert.equal(r.porAno.length, 6);
  });

  test('deflação do IGP-M em 2023: fator 0,9681879 como a calculadora, com aviso', async () => {
    const r = await corrigirValor(FONTE, { valor: 1000, de: '2023-01', ate: '2024-01', indice: 'igpm' }, HOJE_MES);
    assert.equal(r.fator, 0.9681879);
    assert.equal(r.valorCorrigido, 968.19);
    assert.ok(r.avisos.some((a) => /deflação/.test(a)));
  });

  test('mês ainda não publicado no fim: corrige até o último e avisa', async () => {
    const r = await corrigirValor(FONTE, { valor: 100, de: '2026-01-10', ate: '2026-11-05', indice: 'ipca' }, HOJE_MES);
    assert.equal(r.periodo.ate, '2026-09');
    assert.ok(r.avisos.some((a) => /10\/2026 em diante ainda não foi publicado/.test(a)));
  });

  test('entradas inválidas viram ErroFonte com mensagem simples', async () => {
    await assert.rejects(corrigirValor(FONTE, { valor: 100, de: '2025-05', ate: '2025-05', indice: 'ipca' }, HOJE_MES), ErroFonte);
    await assert.rejects(corrigirValor(FONTE, { valor: -1, de: '2025-01', ate: '2025-05', indice: 'ipca' }, HOJE_MES), /valor positivo/);
    await assert.rejects(corrigirValor(FONTE, { valor: 1, de: 'jan', ate: '2025-05', indice: 'ipca' }, HOJE_MES), /Datas inválidas/);
  });

  test('normalizarMes aceita os formatos comuns', () => {
    assert.equal(normalizarMes('2024-03'), '2024-03');
    assert.equal(normalizarMes('2024-03-31'), '2024-03');
    assert.equal(normalizarMes('03/2024'), '2024-03');
    assert.equal(normalizarMes('31/03/2024'), '2024-03');
    assert.equal(normalizarMes('2024-13'), null);
  });
});

describe('índices', () => {
  test('IPCA por período, com acumulado em 12 meses', async () => {
    const r = await consultarIndice(FONTE, { indice: 'ipca', de: '2024-01', ate: '2024-12' });
    assert.equal(r.valores.length, 12);
    assert.match(r.acumuladoNoPeriodo!, /^4\.83% \(01\/2024 a 12\/2024, 12 meses\)$/);
    assert.ok(r.acumulado12Meses);
  });
});

describe('cliente do SGS (HTTP falso)', () => {
  test('monta a URL oficial, lê a resposta e usa o cache', async () => {
    const { amb, chamadas } = ambienteFalso(() =>
      jsonResp([
        { data: '01/01/2024', valor: '0.42' },
        { data: '01/02/2024', valor: '0.83' },
      ]),
    );
    const sgs = criarFonteSgs(amb);
    const m = await sgs.mensal(433, '2024-01', '2024-02');
    assert.equal(m.get('2024-02'), 0.83);
    await sgs.mensal(433, '2024-01', '2024-02');
    assert.equal(chamadas.length, 1, 'segunda chamada sai do cache');
    assert.equal(chamadas[0].url, 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=01/01/2024&dataFinal=29/02/2024');
    assert.match(chamadas[0].headers['user-agent'], /^juris-licita-mcp\//);
  });

  test('429 com Retry-After: espera (com teto) e repete', async () => {
    const { amb, chamadas, esperas } = ambienteFalso((_u, n) => (n === 1 ? jsonResp({}, 429, { 'retry-after': '30' }) : jsonResp([{ data: '04/11/2026', valor: '15' }])));
    const sgs = criarFonteSgs(amb);
    const r = await sgs.ultimos(432, 1);
    assert.equal(r[0].valor, 15);
    assert.equal(chamadas.length, 2);
    assert.ok(esperas.includes(8000), 'Retry-After de 30 s limitado a 8 s');
  });

  test('fonte fora o tempo todo: erro genérico, sem detalhe técnico', async () => {
    const { amb } = ambienteFalso(() => new Response('erro', { status: 502 }));
    await assert.rejects(criarFonteSgs(amb).ultimos(11, 5), (e: unknown) => e instanceof ErroFonte && /não respondeu agora/.test(e.message) && !/502/.test(e.message));
  });

  test('lerRespostaSgs ignora linha quebrada', () => {
    assert.deepEqual(lerRespostaSgs([{ data: '01/01/2024', valor: '0,5' }, { data: 'x', valor: '1' }, null]), [{ periodo: '2024-01-01', valor: 0.5 }]);
  });
});
