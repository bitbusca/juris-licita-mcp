import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prazoProcessual, prazosDaLei } from '../src/ferramentas/prazos.js';

describe('prazo processual (prazos-br)', () => {
  test('DJEN no TJMS/Campo Grande: publicação no 1º dia útil, pula feriado e ponto facultativo, com fonte', () => {
    const r = prazoProcessual({ inicio: '13/11/2026', dias: 15, tribunal: 'TJMS', comarca: 'Campo Grande', evento: 'djen' });
    assert.equal(r.publicacao, '2026-11-16');
    assert.equal(r.inicioContagem, '2026-11-17');
    assert.equal(r.vencimento, '2026-12-10');
    assert.match(r.resumo, /vence em 10\/12\/2026/);
    const pulados = r.marcosEDiasPulados.filter((p) => p.acao === 'pula').map((p) => p.data);
    assert.ok(pulados.includes('2026-11-20') && pulados.includes('2026-12-07') && pulados.includes('2026-12-08'));
    assert.ok(!r.marcosEDiasPulados.some((p) => /sábado|domingo$/.test(p.texto) && p.acao === 'pula' && !p.fonte), 'fim de semana não polui a resposta');
    assert.ok(r.marcosEDiasPulados.filter((p) => p.acao === 'pula').every((p) => p.fonte), 'todo dia pulado tem fonte');
    assert.ok(r.calendariosAplicados.includes('TJMS/campo-grande'));
    assert.ok(r.avisos.some((a) => /conferência profissional/.test(a)));
    assert.match(r.monitorar, /utm_medium=juris-licita-mcp/);
  });

  test('tribunal sem calendário: calcula com os nacionais e avisa', () => {
    const r = prazoProcessual({ inicio: '2026-11-05', dias: 15, tribunal: 'TJAM' });
    assert.ok(r.avisos.some((a) => /TJAM ainda não tem calendário/.test(a)));
    assert.deepEqual(r.calendariosAplicados, ['nacional']);
  });

  test('prazo em dobro da Fazenda conta 30', () => {
    const r = prazoProcessual({ inicio: '2026-03-02', dias: 15, dobro: 'fazenda' });
    assert.equal(r.diasContados, 30);
    assert.equal(r.dobro?.aplicado, true);
  });

  test('entrada inválida vira RangeError com mensagem em português', () => {
    assert.throws(() => prazoProcessual({ inicio: 'ontem', dias: 5 }), (e: unknown) => e instanceof RangeError && /data inválida/.test(e.message));
  });
});

describe('catálogo de prazos da lei', () => {
  test('contestação no cível: 15 dias úteis, CPC', () => {
    const r = prazosDaLei('contestação', { ramo: 'civel' });
    assert.ok(r.total > 0);
    const c = r.prazos.find((p) => /contesta/i.test(p.ato))!;
    assert.equal(c.dias, 15);
    assert.equal(c.contagem, 'uteis');
    assert.match(c.baseLegal, /CPC/);
  });

  test('limite respeitado', () => {
    assert.ok(prazosDaLei('recurso', { limite: 3 }).prazos.length <= 3);
  });
});
