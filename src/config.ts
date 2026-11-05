/**
 * Configuração por variável de ambiente. Nada é obrigatório: sem chave, todas as ferramentas
 * grátis funcionam e as avançadas explicam como obter a chave.
 *
 *   BITBUSCA_API_KEY      chave da BitBusca (bk_test_… grátis com dados fictícios; bk_live_… real)
 *   BITBUSCA_API_URL      base da API REST (padrão https://api.bitbusca.net/api)
 *   BITBUSCA_MCP_URL      MCP remoto do modo avançado (padrão …/v1/mcp/empresas)
 *   JURIS_LICITA_MCP_HTTP_HOST  host do transporte HTTP opcional (padrão 127.0.0.1)
 *   JURIS_LICITA_MCP_HTTP_PORT  porta do transporte HTTP opcional (padrão 3333)
 *
 * Telemetria: NENHUMA. O servidor não conta uso nem manda nada para lugar nenhum além das
 * fontes que a ferramenta chamada precisa (README, seção "Privacidade").
 */

export interface Config {
  /** chave validada pelo formato; undefined = sem chave */
  chave?: string;
  /** a variável veio preenchida, mas com formato que não é de chave BitBusca */
  chaveMalformada: boolean;
  apiUrl: string;
  mcpUrl: string;
}

const API_PADRAO = 'https://api.bitbusca.net/api';

/** bk_live_/bk_test_ (48 hex), bk_oat_ (token OAuth) e a antiga bk_ (48 hex). */
export const RE_CHAVE = /^bk_(?:(?:live|test|oat)_)?[0-9a-f]{48}$/i;

export function ehChaveDeTeste(chave: string | undefined): boolean {
  return Boolean(chave && /^bk_test_/i.test(chave));
}

const semBarraFinal = (s: string) => s.replace(/\/+$/, '');

function urlSegura(valor: string | undefined, padrao: string): string {
  if (!valor) return padrao;
  try {
    const u = new URL(valor);
    // http só para testes locais; em qualquer outro host, https
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return padrao;
    return semBarraFinal(u.toString());
  } catch {
    return padrao;
  }
}

export function lerConfig(env: Record<string, string | undefined> = process.env): Config {
  const bruta = (env.BITBUSCA_API_KEY ?? '').trim();
  const valida = RE_CHAVE.test(bruta);
  const apiUrl = urlSegura(env.BITBUSCA_API_URL, API_PADRAO);
  return {
    chave: valida ? bruta : undefined,
    chaveMalformada: bruta.length > 0 && !valida,
    apiUrl,
    mcpUrl: urlSegura(env.BITBUSCA_MCP_URL, `${apiUrl}/v1/mcp/empresas`),
  };
}

/** Configuração com a chave de um pedido HTTP (Authorization: Bearer …), quando houver. */
export function comChave(cfg: Config, chave: string | undefined): Config {
  if (!chave) return cfg;
  const valida = RE_CHAVE.test(chave);
  return { ...cfg, chave: valida ? chave : undefined, chaveMalformada: !valida };
}
