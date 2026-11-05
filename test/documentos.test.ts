import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dvCnpj, validarCnpj, validarCpf, validarDocumento } from '../src/ferramentas/documentos.js';

// Números de exemplo/sintéticos (gerados pelo próprio algoritmo), nunca de pessoa real.
const CPF_SINTETICO = '123.456.789-09';
const CNPJ_EXEMPLO = '11.222.333/0001-81';
const CNPJ_ALFA_RECEITA = '12.ABC.345/01DE-35'; // exemplo da própria Receita Federal

describe('CPF', () => {
  test('válido pelo dígito, volta só mascarado e com a região fiscal', () => {
    const r = validarCpf(CPF_SINTETICO);
    assert.equal(r.valido, true);
    assert.equal(r.tipo, 'cpf');
    assert.equal(r.mascarado, '***.456.789-**');
    assert.equal(r.formatado, undefined, 'CPF nunca volta inteiro');
    assert.equal(r.detalhes?.regiaoFiscalDeEmissao, 'PR e SC');
    assert.match(r.aviso, /Não consulta nenhuma base/);
  });

  test('dígito errado, tamanho errado e repetidos são inválidos', () => {
    assert.equal(validarCpf('123.456.789-00').valido, false);
    assert.equal(validarCpf('123.456.789-00').motivo, 'Dígito verificador não confere.');
    assert.equal(validarCpf('1234567890').valido, false);
    assert.equal(validarCpf('111.111.111-11').valido, false);
    assert.equal(validarCpf('abc').valido, false);
  });
});

describe('CNPJ', () => {
  test('numérico válido, formatado, com raiz e matriz', () => {
    const r = validarCnpj('11222333000181');
    assert.equal(r.valido, true);
    assert.equal(r.formatado, CNPJ_EXEMPLO);
    assert.deepEqual(r.detalhes, { raiz: '11222333', ordem: '0001', matriz: true, alfanumerico: false });
  });

  test('alfanumérico (IN RFB 2.229/2024): exemplo oficial 12.ABC.345/01DE-35', () => {
    assert.equal(dvCnpj('12ABC34501DE'), '35');
    const r = validarCnpj(CNPJ_ALFA_RECEITA.toLowerCase());
    assert.equal(r.valido, true);
    assert.equal(r.formatado, CNPJ_ALFA_RECEITA);
    assert.equal(r.detalhes?.alfanumerico, true);
    assert.equal(r.detalhes?.matriz, false);
  });

  test('dígito errado, letra no DV e repetidos são inválidos', () => {
    assert.equal(validarCnpj('11.222.333/0001-82').valido, false);
    assert.equal(validarCnpj('12ABC34501DE3A').valido, false);
    assert.equal(validarCnpj('00000000000000').valido, false);
    assert.equal(validarCnpj('AAAAAAAAAAAA00').valido, false);
  });
});

describe('validarDocumento (tipo automático)', () => {
  test('decide pelo tamanho', () => {
    assert.equal(validarDocumento(CPF_SINTETICO).tipo, 'cpf');
    assert.equal(validarDocumento(CNPJ_EXEMPLO).tipo, 'cnpj');
    assert.equal(validarDocumento(CNPJ_ALFA_RECEITA).valido, true);
    assert.equal(validarDocumento('123').tipo, 'desconhecido');
  });

  test('tipo forçado', () => {
    assert.equal(validarDocumento('11222333000181', 'cpf').valido, false);
    assert.equal(validarDocumento('11222333000181', 'cnpj').valido, true);
  });
});
