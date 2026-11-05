/**
 * Textos que a IA repassa ao usuário. Regras: português simples, nenhum detalhe técnico, nenhum
 * nome de fornecedor de dados, nenhum dado de pessoa física.
 */

export const SITE_CHAVE = 'https://bitbusca.net/desenvolvedor';

/** Link da chave grátis com UTM (a ferramenta vai em utm_content para saber o que puxou o clique). */
export function linkChave(ferramenta?: string): string {
  const q = new URLSearchParams({ utm_source: 'github', utm_medium: 'juris-licita-mcp' });
  if (ferramenta) q.set('utm_content', ferramenta);
  return `${SITE_CHAVE}?${q.toString()}`;
}

export const REGRA_COBRANCA =
  'Regra de cobrança da BitBusca: falha técnica não cobra; "nada consta" cobra (a base foi consultada e isso é resposta).';

export function semChave(ferramenta: string, oQueFaz: string): string {
  return [
    `"${ferramenta}" é uma ferramenta do modo avançado do Juris Licita MCP.`,
    `O que ela faz: ${oQueFaz}`,
    '',
    'Para ligar o modo avançado:',
    `1. Crie a chave grátis em ${linkChave(ferramenta)}`,
    '   - a chave de teste (bk_test_…) é grátis para sempre e devolve dados FICTÍCIOS, boa para montar e testar;',
    '   - para dados reais, ative o sandbox (7 dias, créditos de cortesia) ou um plano.',
    '2. Coloque a chave na variável BITBUSCA_API_KEY da configuração deste servidor MCP.',
    '3. Reinicie o app de IA.',
    '',
    'As ferramentas grátis (prazos com feriados forenses, feriados e dias úteis, índices do Banco Central, correção monetária, editais abertos do PNCP e validação de CPF/CNPJ) continuam funcionando sem chave.',
  ].join('\n');
}

export const CHAVE_MALFORMADA = [
  'A variável BITBUSCA_API_KEY está preenchida, mas não parece uma chave da BitBusca.',
  'Ela começa com bk_live_ ou bk_test_ seguida de 48 letras e números. Copie de novo do painel:',
  linkChave('chave-invalida'),
].join('\n');

export const AVANCADO_FORA =
  'O modo avançado não respondeu agora. Nenhum crédito foi gasto por esta falha. Tente de novo em alguns minutos.';

export const AVISO_TESTE =
  'Atenção: resposta com DADOS FICTÍCIOS (chave de teste bk_test_). Para dados reais use uma chave bk_live_.';
