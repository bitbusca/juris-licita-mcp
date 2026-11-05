import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lerConfig } from '../src/config.js';
import { criarClienteCadastro, mascararCpfEmTexto, normalizarCnpj } from '../src/ferramentas/cadastro.js';
import { ambienteFalso, jsonResp } from './apoio.js';

const CHAVE_TESTE = `bk_test_${'a1'.repeat(24)}`;
const CHAVE_LIVE = `bk_live_${'b2'.repeat(24)}`;
const ROTA_INEXISTENTE = () => jsonResp({ message: 'Route GET:/api/publico/v1/cnpj/x not found', error: 'Not Found', statusCode: 404 }, 404);

// Formato da API da BitBusca (chave de teste: dados fictícios, como services/dev/mock.ts)
const CNPJ_API = {
  tipo: 'CNPJ',
  custo: 0,
  ambiente: 'teste',
  dados: {
    estabelecimento: {
      cnpj: '11222333000181',
      razao_social: 'EMPRESA EXEMPLO LTDA',
      nome_fantasia: 'LOJA EXEMPLO',
      situacao_cadastral: 'ATIVA',
      data_inicio_atividade: '2019-05-02T00:00:00.000Z',
      natureza_juridica: 'Sociedade Empresária Limitada',
      porte: 'MICRO EMPRESA',
      capital_social: '50000',
      cnae_fiscal_principal: '6201501',
      cnae_principal_descricao: 'Desenvolvimento de programas de computador sob encomenda',
      logradouro: 'RUA EXEMPLO',
      numero: '100',
      bairro: 'CENTRO',
      cep: '79002000',
      uf: 'MS',
      municipio: 'CAMPO GRANDE',
      telefone_1: '33334444',
      correio_eletronico: 'contato@example.com',
      _teste: true,
    },
    socios: [{ nome_socio_razao_social: 'FULANO FICTICIO', cnpj_cpf_socio: '***123456**' }],
    simples: { opcao_simples: 'S', opcao_mei: 'N' },
  },
};

describe('CEP e CNPJ básico', () => {
  test('sem rota anônima e sem chave: explica como liberar, sem erro', async () => {
    const { amb, chamadas } = ambienteFalso(ROTA_INEXISTENTE);
    const r = await criarClienteCadastro(amb).cnpj('11.222.333/0001-81', lerConfig({}));
    assert.ok('semChave' in r);
    assert.match(r.semChave, /bitbusca\.net\/desenvolvedor\?utm_source=github&utm_medium=juris-licita-mcp&utm_content=consultar_cnpj/);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, 'https://api.bitbusca.net/api/publico/v1/cnpj/11222333000181');
    assert.equal(chamadas[0].headers.authorization, undefined, 'rota anônima nunca leva a chave');
  });

  test('com chave de teste: cai na API com Bearer, marca fictício e corta sócios e contatos', async () => {
    const { amb, chamadas } = ambienteFalso((url) => (url.includes('/publico/') ? ROTA_INEXISTENTE() : jsonResp(CNPJ_API)));
    const r = await criarClienteCadastro(amb).cnpj('11222333000181', lerConfig({ BITBUSCA_API_KEY: CHAVE_TESTE }));
    assert.ok(!('semChave' in r));
    assert.equal(chamadas[1].url, 'https://api.bitbusca.net/api/v1/cnpj/11222333000181');
    assert.equal(chamadas[1].headers.authorization, `Bearer ${CHAVE_TESTE}`);
    assert.equal(r.ficticio, true);
    assert.equal(r.origem, 'chave');
    assert.match(r.avisos[0], /FICTÍCIOS/);
    assert.equal(r.dados.razaoSocial, 'EMPRESA EXEMPLO LTDA');
    assert.equal(r.dados.cnaePrincipal.codigo, '6201501');
    assert.equal(r.dados.inicioAtividade, '2019-05-02');
    assert.equal(r.dados.capitalSocial, 50000);
    assert.equal(r.dados.endereco.logradouro, 'RUA EXEMPLO');
    const texto = JSON.stringify(r);
    assert.ok(!/FULANO|socio|telefone|correio|contato@/i.test(texto), 'nada de sócio nem contato');
  });

  test('rota anônima no ar: usa ela, sem chave', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp({ cep: '79002000', logradouro: 'Rua Exemplo', bairro: 'Centro', cidade: 'Campo Grande', uf: 'MS', ibge: '5002704', ddd: 67 }));
    const r = await criarClienteCadastro(amb).cep('79002-000', lerConfig({}));
    assert.ok(!('semChave' in r));
    assert.equal(r.origem, 'anonima');
    assert.equal(r.dados.cep, '79002-000');
    assert.equal(r.dados.cidade, 'Campo Grande');
    assert.equal(chamadas.length, 1);
  });

  test('rota anônima no limite (429) com chave: usa a chave sem esperar', async () => {
    const { amb, chamadas, esperas } = ambienteFalso((url) =>
      url.includes('/publico/') ? jsonResp({ error: 'limite' }, 429, { 'retry-after': '3600' }) : jsonResp({ tipo: 'CEP', custo: 0, ambiente: 'producao', dados: { cep: '79002000', cidade: 'CAMPO GRANDE', uf: 'MS' } }),
    );
    const r = await criarClienteCadastro(amb).cep('79002000', lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE }));
    assert.ok(!('semChave' in r));
    assert.equal(r.origem, 'chave');
    assert.equal(chamadas.length, 2);
    assert.deepEqual(esperas, []);
  });

  test('"não encontrado" da casa (404 NOT_FOUND) é resposta, não falta de rota', async () => {
    const { amb } = ambienteFalso(() => jsonResp({ error: 'CEP não encontrado.', code: 'NOT_FOUND' }, 404));
    await assert.rejects(criarClienteCadastro(amb).cep('79999999', lerConfig({})), /não encontrado/);
  });

  test('chave recusada (401): mensagem sem detalhe técnico', async () => {
    const { amb } = ambienteFalso((url) => (url.includes('/publico/') ? ROTA_INEXISTENTE() : jsonResp({ error: 'x', code: 'TOKEN_INVALIDO' }, 401)));
    await assert.rejects(criarClienteCadastro(amb).cnpj('11222333000181', lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE })), /foi recusada/);
  });

  test('CNPJ inválido nem sai da máquina', async () => {
    const { amb, chamadas } = ambienteFalso(ROTA_INEXISTENTE);
    await assert.rejects(criarClienteCadastro(amb).cnpj('11222333000182', lerConfig({})), /CNPJ inválido/);
    assert.equal(chamadas.length, 0);
  });

  test('MEI: endereço só com bairro/cidade/UF e CPF mascarado na razão social', () => {
    const { dados, pessoaComoEmpresa } = normalizarCnpj(
      {
        estabelecimento: { razao_social: '12.345.678 FULANA EXEMPLO 12345678909', logradouro: 'RUA X', numero: '10', bairro: 'CENTRO', municipio: 'CAMPO GRANDE', uf: 'MS', cep: '79000000' },
        simples: { opcao_mei: 'S' },
      },
      '12345678000195',
    );
    assert.equal(pessoaComoEmpresa, true);
    assert.equal(dados.endereco.logradouro, null);
    assert.equal(dados.endereco.numero, null);
    assert.equal(dados.endereco.cep, null);
    assert.equal(dados.endereco.municipio, 'CAMPO GRANDE');
    assert.ok(!/12345678909/.test(dados.razaoSocial!));
    assert.equal(mascararCpfEmTexto('CPF 123.456.789-09'), 'CPF ***.***.***-**');
  });
});

describe('CEP e CNPJ: respostas da consulta pública (cota, pausa, fora)', () => {
  test('cota do dia (429 RATE) sem chave: diz que a cota acabou e como liberar', async () => {
    const { amb, chamadas } = ambienteFalso(() => jsonResp({ error: 'Limite diário', code: 'RATE' }, 429, { 'retry-after': '3600' }));
    const r = await criarClienteCadastro(amb).cnpj('11222333000181', lerConfig({}));
    assert.ok('semChave' in r);
    assert.match(r.semChave, /cota grátis .* acabou por hoje/);
    assert.match(r.semChave, /utm_content=consultar_cnpj/);
    assert.equal(chamadas.length, 1);
  });

  test('pausa por sequência (429 ENUMERACAO) sem chave: explica a pausa de 24 horas', async () => {
    const { amb } = ambienteFalso(() => jsonResp({ error: 'pausado', code: 'ENUMERACAO' }, 429, { 'retry-after': '86400' }));
    const r = await criarClienteCadastro(amb).cnpj('11222333000181', lerConfig({}));
    assert.ok('semChave' in r);
    assert.match(r.semChave, /pausada por 24 horas/);
  });

  test('consulta pública fora (503 INDISPONIVEL) com chave: segue pela chave', async () => {
    const { amb, chamadas } = ambienteFalso((url) =>
      url.includes('/publico/') ? jsonResp({ error: 'fora', code: 'INDISPONIVEL' }, 503) : jsonResp({ tipo: 'CEP', custo: 0, ambiente: 'producao', dados: { cep: '79002000', cidade: 'CAMPO GRANDE', uf: 'MS' } }),
    );
    const r = await criarClienteCadastro(amb).cep('79002000', lerConfig({ BITBUSCA_API_KEY: CHAVE_LIVE }));
    assert.ok(!('semChave' in r));
    assert.equal(r.origem, 'chave');
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[0].headers.authorization, undefined);
  });

  test('formato da rota pública de CNPJ (lista fechada do backend) vira o resumo do pacote', async () => {
    const publico = {
      estabelecimento: {
        cnpj: '11222333000181', razao_social: 'EMPRESA EXEMPLO LTDA', nome_fantasia: 'EXEMPLO', situacao_cadastral: 'ATIVA',
        data_situacao_cadastral: '2015-06-01', data_inicio_atividade: '2010-01-15', natureza_juridica: 'Sociedade Empresária Limitada',
        porte: 'MICRO EMPRESA', capital_social: 10000, matriz_filial: 'MATRIZ', cnae_fiscal_principal: '6201501',
        cnae_principal_descricao: 'Desenvolvimento de programas de computador sob encomenda', logradouro: 'RUA EXEMPLO', numero: '100',
        complemento: null, bairro: 'CENTRO', municipio: 'CAMPO GRANDE', uf: 'MS', cep: '79002000',
      },
      simples: { opcao_simples: true, opcao_mei: false },
    };
    const { amb } = ambienteFalso(() => jsonResp(publico));
    const r = await criarClienteCadastro(amb).cnpj('11222333000181', lerConfig({}));
    assert.ok(!('semChave' in r));
    assert.equal(r.origem, 'anonima');
    assert.equal(r.dados.situacaoCadastral, 'ATIVA');
    assert.equal(r.dados.capitalSocial, 10000);
    assert.equal(r.dados.endereco.logradouro, 'RUA EXEMPLO');
    assert.deepEqual(r.dados.simples, { optanteSimples: true, mei: false });
  });
});
