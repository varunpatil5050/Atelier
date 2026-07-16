import type { UserInfo } from "@atelier/protocol";
import { ensureSession, mintRoomToken } from "./coreApi";

const STORAGE_KEY = "atelier.identity";

const ADJECTIVES = [
  "amber", "brisk", "coral", "dusky", "eager", "fuzzy", "gilded", "hazel",
  "ivory", "jade", "keen", "lunar", "mossy", "noble", "opal", "plucky",
];
const ANIMALS = [
  "otter", "falcon", "lynx", "heron", "badger", "iguana", "magpie", "narwhal",
  "ocelot", "puffin", "quokka", "raven", "stoat", "tapir", "urchin", "vole",
];
const COLORS = [
  "#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6",
  "#eab308", "#ef4444", "#8b5cf6", "#06b6d4",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

/** Locally-generated identity, used only as the tokenless-mode fallback. */
function localIdentity(): UserInfo {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UserInfo;
      if (parsed.id && parsed.name && parsed.color) return parsed;
    }
  } catch {
    // fall through to regeneration
  }
  const identity: UserInfo = {
    id: crypto.randomUUID(),
    name: `${pick(ADJECTIVES)}-${pick(ANIMALS)}`,
    color: pick(COLORS),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // private browsing etc. — ephemeral identity is fine
  }
  return identity;
}

export interface RoomAuth {
  user: UserInfo;
  /** Per-connect token supplier for AtelierProvider; undefined in tokenless mode. */
  getToken?: () => Promise<string | undefined>;
  authenticated: boolean;
}

/**
 * Resolve identity + token strategy for a room. Prefers a core-api session
 * (server identity + fresh room tokens); falls back to a local identity with
 * no token so the tokenless quickstart still works.
 */
export async function resolveRoomAuth(room: string): Promise<RoomAuth> {
  try {
    const user = await ensureSession();
    return {
      user,
      authenticated: true,
      getToken: async () => (await mintRoomToken(room)).token,
    };
  } catch {
    return { user: localIdentity(), authenticated: false };
  }
}

export function relayWsUrl(): string {
  const base = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://localhost:8787";
  return `${base.replace(/\/$/, "")}/ws`;
}
