/**
 * Client for the intelligence plane (indexer service). Optional like
 * core-api: when unreachable, the IDE simply hides symbol search.
 */

export interface SymbolHit {
  score: number;
  name: string;
  kind: string; // fn | method | class | interface | type | enum
  lang: string;
  path: string; // workspace-relative — same keys as the CRDT file map
  line: number;
  end_line: number;
  container?: string;
  preview: string;
}

export function intelBase(): string {
  return (process.env.NEXT_PUBLIC_INTEL_URL ?? "http://localhost:8789").replace(/\/$/, "");
}

export async function intelReachable(): Promise<boolean> {
  try {
    const res = await fetch(intelBase() + "/healthz");
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchSymbols(q: string, limit = 20): Promise<SymbolHit[]> {
  const res = await fetch(
    `${intelBase()}/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`intel search: ${res.status}`);
  const { results } = (await res.json()) as { results: SymbolHit[] };
  return results;
}

export interface Reference {
  callee: string;
  path: string;
  line: number;
  in_symbol?: string;
  preview: string;
}

export interface Refs {
  name: string;
  confidence: string; // "heuristic" for name-based resolution
  count: number; // total call sites
  files: number; // distinct files (1-hop blast radius)
  callers: Reference[];
}

/** Callers of a symbol name, with a blast-radius summary (doc 06 §8). */
export async function getReferences(name: string): Promise<Refs> {
  const res = await fetch(`${intelBase()}/v1/refs?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`intel refs: ${res.status}`);
  const { refs } = (await res.json()) as { refs: Refs };
  return refs;
}

export interface RetrievedChunk {
  path: string;
  line: number;
  end_line: number;
  symbol?: string;
  kind: string;
  header: string;
  preview: string;
  score: number;
  why: string[]; // "semantic" and/or "lexical"
}

/**
 * Hybrid retrieval — semantic + lexical fused by RRF (doc 06 §6). Finds code
 * by content, not just by symbol name; this is the endpoint agents will query.
 */
export async function retrieve(q: string, limit = 10): Promise<RetrievedChunk[]> {
  const res = await fetch(
    `${intelBase()}/v1/retrieve?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`intel retrieve: ${res.status}`);
  const { results } = (await res.json()) as { results: RetrievedChunk[] };
  return results;
}
