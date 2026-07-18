/**
 * Replay timeline client (blueprint doc 12): fetches a room's recorded event
 * log from the relay and reconstructs document state at any point by applying
 * CRDT updates up to a scrub index.
 *
 * v0: rebuild-from-scratch on each seek (apply updates[0..i] to a fresh
 * Y.Doc). Yjs applies thousands of updates/ms, so this is fine at workspace
 * scale; periodic snapshots (doc 12 §4) are the seek optimization for long
 * sessions.
 */
import * as Y from "yjs";

export interface TimelineEvent {
  seq: number;
  ts: number; // wall-clock ms
  kind: "crdt" | "join" | "leave";
  data?: string; // base64 Yjs update (crdt)
  user?: { id: string; name: string; color: string };
}

export function relayHttpBase(): string {
  const ws = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://localhost:8787";
  return ws.replace(/^ws/, "http").replace(/\/$/, "");
}

export async function fetchTimeline(room: string): Promise<TimelineEvent[]> {
  const res = await fetch(`${relayHttpBase()}/timeline/${encodeURIComponent(room)}`);
  if (!res.ok) throw new Error(`timeline ${room}: ${res.status}`);
  const text = await res.text();
  const events: TimelineEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    events.push(JSON.parse(line) as TimelineEvent);
  }
  return events;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Reconstruct the room's files at scrub index `upTo` (inclusive) by applying
 * every CRDT update at or before it. Returns a fresh, disposable Y.Doc.
 */
export function reconstructAt(events: TimelineEvent[], upTo: number): Y.Doc {
  const doc = new Y.Doc();
  for (let i = 0; i <= upTo && i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "crdt" && ev.data) {
      try {
        Y.applyUpdate(doc, b64ToBytes(ev.data));
      } catch {
        // A corrupt/partial update shouldn't abort the whole rebuild.
      }
    }
  }
  return doc;
}

/** Files present in the reconstructed doc, as path → text. */
export function filesOf(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  const files = doc.getMap<Y.Text>("files");
  for (const [path, value] of files.entries()) {
    out.set(path, value instanceof Y.Text ? value.toString() : String(value ?? ""));
  }
  return out;
}

/** Participant set present at scrub index `upTo`, derived from join/leave. */
export function presenceAt(
  events: TimelineEvent[],
  upTo: number,
): Array<{ id: string; name: string; color: string }> {
  const present = new Map<string, { id: string; name: string; color: string }>();
  for (let i = 0; i <= upTo && i < events.length; i++) {
    const ev = events[i]!;
    if (!ev.user) continue;
    if (ev.kind === "join") present.set(ev.user.id, ev.user);
    else if (ev.kind === "leave") present.delete(ev.user.id);
  }
  return [...present.values()];
}
