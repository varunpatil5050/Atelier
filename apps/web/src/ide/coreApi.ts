import type { UserInfo } from "@atelier/protocol";

/**
 * Client for core-api (the control plane). Every call degrades gracefully: if
 * core-api is unreachable the IDE still works in tokenless dev mode, so the
 * zero-dependency `relay + web` quickstart keeps working.
 */

export function coreApiBase(): string {
  return (process.env.NEXT_PUBLIC_CORE_API_URL ?? "http://localhost:8788").replace(/\/$/, "");
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  lastOpenedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(coreApiBase() + path, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) throw new Error(`core-api ${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Ensure a server session exists; returns the server identity. */
export async function ensureSession(): Promise<UserInfo> {
  const { user } = await req<{ user: UserInfo }>("/v1/session", { method: "POST" });
  return user;
}

export interface RoomTokenResponse {
  token: string;
  user: UserInfo;
  workspace: { id: string; slug: string; name: string };
}

export async function mintRoomToken(room: string): Promise<RoomTokenResponse> {
  return req<RoomTokenResponse>(`/v1/rooms/${encodeURIComponent(room)}/token`, { method: "POST" });
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const { workspaces } = await req<{ workspaces: Workspace[] }>("/v1/workspaces");
  return workspaces;
}

/**
 * Fire-and-forget RUM sample (blueprint doc 10 §2: SLIs are measured
 * client-side). Never throws, never blocks the UI.
 */
export function postRumSample(kind: "ws_rtt", ms: number): void {
  void fetch(coreApiBase() + "/v1/rum", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ms }),
    keepalive: true,
  }).catch(() => {
    // core-api down/unreachable — RUM is best-effort by definition
  });
}

/** True if core-api answered a session request. */
export async function coreApiReachable(): Promise<boolean> {
  try {
    await ensureSession();
    return true;
  } catch {
    return false;
  }
}
