import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoCobertura, contarDiasUteis, feriadosDoAno, normalizarDia, somarDiasUteis } from '../src/ferramentas/feriados.js';

describe('feriados (dados do prazos-br)', () => {
  test('nacionais de 2026, com a lei de cada um, sem suspensão de prazos', () => {
    const r = feriadosDoAno(2026);
    assert.equal(r.calendario, 'nacional');
    const datas = r.dias.map((d) => d.data);
    for (const d of ['2026-01-01', '2026-04-03', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) {
      assert.ok(datas.includes(d), `falta ${d}`);
    }
    assert.ok(!r.dias.some((d) => d.tipo === 'suspensao_prazos'));
    assert.ok(r.dias.every((d) => d.fonte), 'cada feriado com a fonte');
    assert.equal(r.dias.find((d) => d.data === '2026-12-25')?.diaDaSemana, 'sexta-feira');
  });

  test('Consciência Negra é nacional só a partir de 2024', () => {
    assert.ok(feriadosDoAno(2024).dias.some((d) => d.data === '2024-11-20'));
    assert.ok(!feriadosDoAno(2023).dias.some((d) => d.data === '2023-11-20'));
  });

  test('bancário inclui Carnaval e Corpus Christi', () => {
    const r = feriadosDoAno(2026, { calendario: 'bancario' });
    const datas = r.dias.map((d) => d.data);
    assert.ok(datas.includes('2026-02-16') && datas.includes('2026-02-17') && datas.includes('2026-06-04'));
  });

  test('forense TJMS/Campo Grande: feriado municipal e recesso agrupado em período', () => {
    const r = feriadosDoAno(2026, { tribunal: 'tjms', comarca: 'Campo Grande' });
    assert.equal(r.calendario, 'forense');
    assert.equal(r.tribunal, 'TJMS');
    assert.ok(r.dias.some((d) => d.data === '2026-08-26' && /Campo Grande/.test(d.nome)), 'aniversário de Campo Grande');
    const recesso = r.dias.find((d) => d.de && d.tipo === 'recesso' && d.de.startsWith('2026-12'));
    assert.ok(recesso && recesso.ate! > recesso.de!, 'recesso de fim de ano vem como período');
    assert.equal(r.aviso, undefined, 'TJMS 2026 é coberto');
  });
});

describe('cobertura sempre dita', () => {
  test('tribunal sem calendário próprio: aviso com a lista dos cobertos', () => {
    const a = avisoCobertura({ tribunal: 'TJSP' }, [2026])!;
    assert.match(a, /Ainda não temos o calendário forense do TJSP/);
    assert.match(a, /TJMS/);
    assert.match(a, /outros em breve/);
  });

  test('comarca desconhecida e ano não conferido', () => {
    const a = avisoCobertura({ tribunal: 'TJMS', comarca: 'Cidade Inexistente' }, [2031])!;
    assert.match(a, /não encontrada no TJMS/);
    assert.match(a, /2031 ainda não/);
  });

  test('calendário nacional não precisa de aviso', () => {
    assert.equal(avisoCobertura({}, [2026]), null);
  });
});

describe('dias úteis', () => {
  test('nacional: exclui o dia inicial, inclui o final, pula a Consciência Negra', () => {
    // 13/11/2026 (sex) → 23/11/2026 (seg): úteis 16, 17, 18, 19 e 23
    const r = contarDiasUteis('2026-11-13', '2026-11-23');
    assert.equal(r.diasUteis, 5);
    assert.equal(r.diasCorridos, 10);
    assert.deepEqual(
      r.diasNaoContadosForaFimDeSemana.map((d) => ('data' in d ? d.data : d.de)),
      ['2026-11-20'],
    );
  });

  test('forense TJMS conta menos que o nacional em dezembro (ponto facultativo, Dia da Justiça)', () => {
    const nac = contarDiasUteis('2026-12-01', '2026-12-11').diasUteis;
    const tj = contarDiasUteis('2026-12-01', '2026-12-11', { tribunal: 'TJMS', comarca: 'Campo Grande' }).diasUteis;
    assert.equal(nac, 8);
    assert.equal(tj, 6);
  });

  test('somar: Carnaval só pula no bancário', () => {
    assert.equal(somarDiasUteis('2026-02-13', 1).resultado, '2026-02-16');
    const b = somarDiasUteis('2026-02-13', 1, { calendario: 'bancario' });
    assert.equal(b.resultado, '2026-02-18');
    assert.deepEqual(
      b.pulados.map((p) => ('data' in p ? p.data : p.de)),
      ['2026-02-16', '2026-02-17'],
    );
  });

  test('somar no forense atravessa a suspensão de 20/12 a 20/01 (CPC art. 220)', () => {
    const r = somarDiasUteis('2026-12-18', 1, { tribunal: 'TJMS' });
    assert.equal(r.resultado, '2027-01-21');
    // 20/12/2026 é domingo (fim de semana não entra na lista); o resto vem em períodos, com a fonte
    assert.ok(r.pulados.some((p) => 'de' in p && p.de === '2026-12-21'), 'recesso vem como período');
    assert.ok(r.pulados.some((p) => 'ate' in p && p.ate === '2027-01-20' && /CPC, art. 220/.test(p.fonte ?? '')), 'suspensão até 20/01 com a fonte');
  });

  test('nacional: Natal e virada do ano; subtração; zero dias', () => {
    assert.equal(somarDiasUteis('2026-12-24', 1).resultado, '2026-12-28');
    assert.equal(somarDiasUteis('2026-12-31', 1).resultado, '2027-01-04');
    assert.equal(somarDiasUteis('2026-11-23', -1).resultado, '2026-11-19');
    assert.equal(somarDiasUteis('2026-11-21', 0).resultado, '2026-11-23');
  });

  test('limites e entrada', () => {
    assert.throws(() => somarDiasUteis('2026-01-01', 100000), RangeError);
    assert.equal(normalizarDia('31/12/2026'), '2026-12-31');
    assert.equal(normalizarDia('2026-02-30'), null);
  });
});
