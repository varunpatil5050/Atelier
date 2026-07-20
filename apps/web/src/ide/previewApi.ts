/**
 * Client for the preview-router (blueprint doc 05 §7). Lists the live preview
 * URLs for a room's running dev servers. Degrades gracefully: if the router is
 * not running, the IDE simply shows no previews (the feature is opt-in — you
 * start a preview-router + workspace-host to get preview URLs).
 */

export interface Preview {
  room: string;
  port: number;
  name: string;
  /** Pretty, shareable URL: http://{port}--{room}.preview.localhost:8790/ */
  url: string;
  /** Fallback path URL that resolves without wildcard DNS. */
  pathUrl: string;
}

export function previewRouterBase(): string {
  return (process.env.NEXT_PUBLIC_PREVIEW_ROUTER_URL ?? "http://localhost:8790").replace(/\/$/, "");
}

/** Fetch the room's live previews. Returns [] on any error (router down, etc.). */
export async function fetchPreviews(room: string, signal?: AbortSignal): Promise<Preview[]> {
  try {
    const res = await fetch(`${previewRouterBase()}/v1/previews/${encodeURIComponent(room)}`, {
      signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { previews?: Preview[] };
    return body.previews ?? [];
  } catch {
    return [];
  }
}
