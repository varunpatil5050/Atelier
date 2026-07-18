/**
 * The scribe agent run (blueprint doc 07, v0 scale): an agent that joins a
 * room as a first-class participant — same @atelier/client, same presence
 * protocol as humans — retrieves context from the intelligence plane, asks
 * the model-gateway for a patch, and types it into the live CRDT where every
 * collaborator can watch it happen.
 *
 * Steps (each an event in the run log): plan → retrieve → generate → apply.
 */

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { RunLog, now, type RunState } from "./events.js";
import { contentHash, type ModelProvider } from "./gateway.js";
import type { Intel, SymbolHit } from "./intel.js";

export interface RunOptions {
  relayUrl: string; // ws://host:port (no /ws suffix)
  room: string;
  goal: string; // v0 grammar: "document <symbolName>"
  provider: ModelProvider;
  intel: Intel;
  serviceToken?: string; // for auth-enforced relays
  logDir?: string;
  /** Delay between typed lines so humans can watch the agent work. */
  typeDelayMs?: number;
  syncTimeoutMs?: number;
}

const AGENT_COLOR = "#a855f7";

export async function runScribe(opts: RunOptions): Promise<RunState> {
  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = new RunLog(runId, opts.logDir);
  log.append({ type: "run.started", runId, room: opts.room, goal: opts.goal, at: now() });

  const conn = new WsConnection(`${opts.relayUrl.replace(/\/$/, "")}/ws`);
  const agentUser = {
    id: `agent-scribe-${runId.slice(-8)}`,
    name: "scribe (agent)",
    color: AGENT_COLOR,
  };
  const provider = new AtelierProvider(conn, opts.room, agentUser, {
    ...(opts.serviceToken ? { getToken: async () => opts.serviceToken } : {}),
  });
  provider.awareness.setLocalStateField("user", agentUser);

  try {
    conn.connect();
    await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);

    // ── plan ─────────────────────────────────────────────────────────────
    log.append({ type: "step.started", step: "plan", at: now() });
    const target = parseGoal(opts.goal);

    // ── retrieve ─────────────────────────────────────────────────────────
    log.append({ type: "step.started", step: "retrieve", at: now() });
    const hits = await opts.intel.search(target, 10);
    const hit = hits.find((h) => h.name === target) ?? hits[0];
    log.append({
      type: "retrieval.result",
      query: target,
      hits: hits.length,
      ...(hit ? { top: `${hit.path}:${hit.line}` } : {}),
      at: now(),
    });
    if (!hit) {
      throw new Error(`no symbol found for "${target}"`);
    }
    const refs = await opts.intel.refs(hit.name);

    // ── generate ─────────────────────────────────────────────────────────
    log.append({ type: "step.started", step: "generate", at: now() });
    const prompt = buildPrompt(hit, refs.count, refs.files, refs.callers[0]?.in_symbol);
    log.append({
      type: "model.call",
      provider: opts.provider.name,
      promptHash: contentHash(prompt),
      at: now(),
    });
    const response = await opts.provider.complete({
      system: "You are scribe, Atelier's documentation agent. Respond with JSON: {\"comment\": string}.",
      prompt,
    });
    log.append({ type: "model.result", outputHash: contentHash(response.text), at: now() });
    const { comment } = JSON.parse(response.text) as { comment: string };
    if (!comment || !comment.startsWith("/**")) {
      throw new Error("model returned no usable comment");
    }

    // ── apply ────────────────────────────────────────────────────────────
    log.append({ type: "step.started", step: "apply", at: now() });
    const files = provider.doc.getMap<Y.Text>("files");
    const ytext = files.get(hit.path);
    if (!ytext) {
      throw new Error(`file ${hit.path} is not in the room's file map`);
    }

    const { offset, indent } = locateInsertion(ytext.toString(), hit);
    const lines = comment.split("\n").map((l) => indent + l);
    log.append({
      type: "patch.proposed",
      path: hit.path,
      line: hit.line,
      lines: lines.length,
      at: now(),
    });

    // Type line-by-line so collaborators watch the agent work (presence is
    // already visible; the edits attribute to it in real time).
    let cursor = offset;
    for (const line of lines) {
      ytext.insert(cursor, line + "\n");
      cursor += line.length + 1;
      await sleep(opts.typeDelayMs ?? 120);
    }
    log.append({ type: "patch.applied", path: hit.path, at: now() });

    // Give the final update a beat to flush through the relay.
    await sleep(300);
    log.append({ type: "run.finished", status: "applied", at: now() });
    return log.fold();
  } catch (err) {
    log.append({
      type: "run.finished",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      at: now(),
    });
    return log.fold();
  } finally {
    provider.destroy();
  }
}

/** v0 goal grammar: "document <symbol>". The Planner agent generalizes this. */
function parseGoal(goal: string): string {
  const m = goal.trim().match(/^document\s+([A-Za-z_$][\w$]*)$/);
  if (!m || !m[1]) {
    throw new Error(`unsupported goal ${JSON.stringify(goal)} — expected "document <symbol>"`);
  }
  return m[1];
}

function buildPrompt(
  hit: SymbolHit,
  callers: number,
  callerFiles: number,
  topCaller: string | undefined,
): string {
  const facts = {
    symbol: hit.name,
    kind: hit.kind,
    path: hit.path,
    line: hit.line,
    ...(hit.container ? { container: hit.container } : {}),
    callers,
    callerFiles,
    ...(topCaller ? { topCaller } : {}),
    preview: hit.preview,
  };
  return [
    "Write a concise doc comment for this symbol.",
    `FACTS: ${JSON.stringify(facts)}`,
    'Respond with JSON: {"comment": "/** ... */"}',
  ].join("\n");
}

/**
 * Find where to insert the comment in the LIVE text. The index reflects disk;
 * the CRDT may have drifted, so anchor on the definition's first line
 * (preview) when it can be found, falling back to the indexed line number.
 * Returns the offset of that line's start and its leading indentation.
 */
export function locateInsertion(
  text: string,
  hit: { line: number; preview: string },
): { offset: number; indent: string } {
  const lines = text.split("\n");
  const wanted = hit.preview.trim();

  let lineIdx = -1;
  if (wanted.length > 0) {
    lineIdx = lines.findIndex((l) => l.trim() === wanted);
  }
  if (lineIdx === -1) {
    lineIdx = Math.min(Math.max(hit.line - 1, 0), Math.max(lines.length - 1, 0));
  }

  let offset = 0;
  for (let i = 0; i < lineIdx; i++) {
    offset += lines[i]!.length + 1;
  }
  const target = lines[lineIdx] ?? "";
  const indent = target.slice(0, target.length - target.trimStart().length);
  return { offset, indent };
}

function waitSynced(provider: AtelierProvider, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Subscribe-then-check: sync may already be done (the seed-race lesson).
    const timer = setTimeout(
      () => reject(new Error(`relay sync timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const off = provider.onSynced((synced) => {
      if (synced) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    if (provider.synced) {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
