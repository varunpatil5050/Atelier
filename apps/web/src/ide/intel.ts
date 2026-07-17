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
