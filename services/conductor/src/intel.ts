/**
 * Intelligence-plane client for agents (the indexer's HTTP API). `Intel` is
 * an interface so tests inject fakes; agents never hardcode the transport.
 */

export interface SymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
  preview: string;
}

export interface Refs {
  name: string;
  confidence: string;
  count: number;
  files: number;
  callers: Array<{ path: string; line: number; in_symbol?: string }>;
}

export interface Intel {
  search(q: string, limit?: number): Promise<SymbolHit[]>;
  refs(name: string): Promise<Refs>;
}

export class HttpIntel implements Intel {
  constructor(private readonly base: string) {}

  async search(q: string, limit = 10): Promise<SymbolHit[]> {
    const res = await fetch(
      `${this.base}/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`intel search: ${res.status}`);
    const { results } = (await res.json()) as { results: SymbolHit[] };
    return results;
  }

  async refs(name: string): Promise<Refs> {
    const res = await fetch(`${this.base}/v1/refs?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`intel refs: ${res.status}`);
    const { refs } = (await res.json()) as { refs: Refs };
    return refs;
  }
}
