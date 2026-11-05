import { VERSAO } from '../versao.js';

/**
 * HTTP das fontes públicas, com educação: intervalo mínimo por fonte, recuo (backoff) em 429/5xx,
 * Retry-After respeitado (com teto, porque tem gente esperando a resposta no chat) e corte por
 * tempo. Nada de repetir 4xx definitivo.
 *
 * `fetch` e `esperar` são injetáveis para os testes rodarem sem rede e sem relógio.
 */

export type Buscador = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = `juris-licita-mcp/${VERSAO} (+https://github.com/bitbusca/juris-licita-mcp)`;

export interface AmbienteHttp {
  fetch: Buscador;
  esperar: (ms: number) => Promise<void>;
  agora: () => number;
}

export const ambienteReal = (): AmbienteHttp => ({
  fetch: (url, init) => fetch(url, init),
  esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
  agora: Date.now,
});

/** Erro de fonte: a mensagem já é a que pode ir para o usuário (genérica, sem detalhe técnico). */
export class ErroFonte extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
    readonly codigo: 'LIMITE' | 'INDISPONIVEL' | 'NAO_ENCONTRADO' | 'ENTRADA',
  ) {
    super(mensagem);
    this.name = 'ErroFonte';
  }
}

/** Fila por fonte: garante um intervalo mínimo entre o fim de uma chamada e o início da próxima. */
export class Ritmo {
  private fila: Promise<void> = Promise.resolve();
  private ultimoFim = 0;

  constructor(
    public intervaloMs: number,
    private readonly amb: Pick<AmbienteHttp, 'esperar' | 'agora'>,
  ) {}

  /** Executa `fn` respeitando o intervalo (uma chamada por vez nesta fonte). */
  async vez<T>(fn: () => Promise<T>): Promise<T> {
    const antes = this.fila;
    let soltar!: () => void;
    this.fila = new Promise<void>((r) => (soltar = r));
    await antes;
    try {
      const falta = this.intervaloMs - (this.amb.agora() - this.ultimoFim);
      if (falta > 0 && this.ultimoFim > 0) await this.amb.esperar(falta);
      return await fn();
    } finally {
      this.ultimoFim = this.amb.agora();
      soltar();
    }
  }
}

/** Diagnóstico local (stderr) só com JURIS_LICITA_MCP_DEBUG=1. Nunca vai para a IA nem para fora. */
function depurar(m: string) {
  if (process.env.JURIS_LICITA_MCP_DEBUG) console.error(`[juris-licita-mcp] ${m}`);
}

export interface PedidoJson {
  url: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** tentativas no total (1 = sem repetir). Padrão 3. */
  tentativas?: number;
  timeoutMs?: number;
  /** maior espera aceitável num 429 com Retry-After (ms). Padrão 8 s. */
  tetoEsperaMs?: number;
  /** recuos entre tentativas (ms). Padrão [1500, 4000]. */
  recuos?: number[];
  ritmo?: Ritmo;
}

export interface RespostaJson<T> {
  status: number;
  data: T | null;
}

/**
 * GET/POST que devolve JSON. 200 → dados; 204 → data null; 4xx definitivo → status sem dados
 * (quem chama decide: 404 costuma ser "não encontrado"). 429/5xx/rede → repete com recuo e, se
 * esgotar, lança ErroFonte (LIMITE ou INDISPONIVEL).
 */
export async function pedirJson<T>(amb: AmbienteHttp, p: PedidoJson): Promise<RespostaJson<T>> {
  const tentativas = Math.max(1, p.tentativas ?? 3);
  const recuos = p.recuos ?? [1500, 4000];
  const teto = p.tetoEsperaMs ?? 8000;
  let ultimo429 = false;
  for (let t = 0; t < tentativas; t++) {
    const recuo = recuos[Math.min(t, recuos.length - 1)] ?? 2000;
    const exec = async (): Promise<{ fim: RespostaJson<T> } | { esperar: number; limite: boolean }> => {
      try {
        return await tentar();
      } catch (e: any) {
        // rede caiu (antes ou no meio do corpo), tempo esgotado: falha passageira
        // conexão reaproveitada derrubada pelo outro lado (ECONNRESET) é comum: repete logo
        depurar(`${p.url} → ${e?.cause?.code ?? e?.name ?? 'erro de rede'}`);
        return { esperar: Math.min(recuo, 800), limite: false };
      }
    };
    const tentar = async (): Promise<{ fim: RespostaJson<T> } | { esperar: number; limite: boolean }> => {
      const r = await amb.fetch(p.url, {
        method: p.method ?? 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(p.headers ?? {}) },
        body: p.body,
        signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
      });
      if (r.status !== 200) depurar(`${p.url} → HTTP ${r.status}`);
      if (r.status === 204) return { fim: { status: 204, data: null } };
      if (r.status >= 200 && r.status < 300) {
        const texto = await r.text();
        // 200 sem corpo costuma ser falha passageira do outro lado: repete
        if (!texto) {
          depurar(`${p.url} → 200 sem corpo`);
          return { esperar: recuo, limite: false };
        }
        try {
          return { fim: { status: r.status, data: JSON.parse(texto) as T } };
        } catch {
          // corpo truncado/HTML com 200: trata como falha passageira
          return { esperar: recuo, limite: false };
        }
      }
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        return { esperar: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, teto) : recuo, limite: true };
      }
      if (r.status >= 500) return { esperar: recuo, limite: false };
      // 4xx definitivo: devolve o corpo (se for JSON) para quem chamou decidir
      let corpo: T | null = null;
      try {
        corpo = JSON.parse(await r.text()) as T;
      } catch {
        corpo = null;
      }
      return { fim: { status: r.status, data: corpo } };
    };
    const res = p.ritmo ? await p.ritmo.vez(exec) : await exec();
    if ('fim' in res) return res.fim;
    ultimo429 = res.limite;
    if (res.limite && p.ritmo) p.ritmo.intervaloMs = Math.min(Math.round(p.ritmo.intervaloMs * 1.5), 10_000);
    if (t < tentativas - 1) await amb.esperar(res.esperar);
  }
  if (ultimo429) throw new ErroFonte('A fonte pública está limitando consultas agora. Tente de novo em um minuto.', 429, 'LIMITE');
  throw new ErroFonte('A fonte pública não respondeu agora. Tente de novo em alguns minutos.', 503, 'INDISPONIVEL');
}
