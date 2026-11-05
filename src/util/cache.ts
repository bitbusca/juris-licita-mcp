/**
 * Cache em memória com validade (TTL) e teto de itens. Só vive enquanto o processo vive: nada vai
 * para disco. Também junta pedidos iguais em andamento (dois "qual a SELIC?" ao mesmo tempo viram
 * uma chamada só à fonte).
 */
export class CacheMemoria<T> {
  private readonly itens = new Map<string, { valor: T; expira: number }>();
  private readonly emAndamento = new Map<string, Promise<T>>();

  constructor(
    private readonly maxItens = 500,
    private readonly agora: () => number = Date.now,
  ) {}

  ler(chave: string): T | undefined {
    const it = this.itens.get(chave);
    if (!it) return undefined;
    if (it.expira <= this.agora()) {
      this.itens.delete(chave);
      return undefined;
    }
    return it.valor;
  }

  gravar(chave: string, valor: T, ttlMs: number): void {
    if (this.itens.size >= this.maxItens) {
      // o mais antigo sai primeiro (Map mantém a ordem de inserção)
      const primeira = this.itens.keys().next().value;
      if (primeira !== undefined) this.itens.delete(primeira);
    }
    this.itens.set(chave, { valor, expira: this.agora() + ttlMs });
  }

  /** Devolve do cache ou busca (uma vez só por chave, mesmo com pedidos simultâneos). */
  async obter(chave: string, ttlMs: number, buscar: () => Promise<T>): Promise<T> {
    const salvo = this.ler(chave);
    if (salvo !== undefined) return salvo;
    const andando = this.emAndamento.get(chave);
    if (andando) return andando;
    const p = buscar()
      .then((v) => {
        this.gravar(chave, v, ttlMs);
        return v;
      })
      .finally(() => this.emAndamento.delete(chave));
    this.emAndamento.set(chave, p);
    return p;
  }

  limpar(): void {
    this.itens.clear();
  }

  get tamanho(): number {
    return this.itens.size;
  }
}
