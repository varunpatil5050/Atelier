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
import { PROPOSALS_KEY, type Proposal } from "./proposals.js";
import { TraceWriter } from "./trace.js";

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
  /**
   * Human-in-the-loop gate (doc 07 §4). Default true: the agent writes a
   * proposal into Y.Map("proposals") and applies only after a human approves
   * it in the IDE. false = direct apply (demos/tests).
   */
  requireApproval?: boolean;
  /** How long to park on a pending proposal before failing the run. */
  approvalTimeoutMs?: number;
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

  // Narrates reasoning into the shared doc once synced (live + replayable).
  let trace: TraceWriter | null = null;

  try {
    conn.connect();
    await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);
    trace = new TraceWriter(provider.doc, runId, agentUser.name);
    trace.step("started", `goal: ${JSON.stringify(opts.goal)}`);

    // ── plan ─────────────────────────────────────────────────────────────
    log.append({ type: "step.started", step: "plan", at: now() });
    const target = parseGoal(opts.goal);
    trace.step("plan", `target symbol: ${target}`);

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
    trace.step(
      "retrieve",
      `found ${hit.kind} ${hit.name} at ${hit.path}:${hit.line}; ` +
        `${refs.count} caller${refs.count === 1 ? "" : "s"} across ${refs.files} file${refs.files === 1 ? "" : "s"}` +
        (refs.callers[0]?.in_symbol ? ` (e.g. ${refs.callers[0].in_symbol})` : ""),
    );

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
    trace.step(
      "generate",
      `model "${opts.provider.name}" produced a ${comment.split("\n").length}-line doc comment`,
    );

    // ── propose ──────────────────────────────────────────────────────────
    const files = provider.doc.getMap<Y.Text>("files");
    const ytext = files.get(hit.path);
    if (!ytext) {
      throw new Error(`file ${hit.path} is not in the room's file map`);
    }
    const { indent } = locateInsertion(ytext.toString(), hit);
    const lines = comment.split("\n").map((l) => indent + l);
    const insertText = lines.join("\n");
    log.append({
      type: "patch.proposed",
      path: hit.path,
      line: hit.line,
      lines: lines.length,
      at: now(),
    });

    if (opts.requireApproval !== false) {
      log.append({ type: "step.started", step: "propose", at: now() });
      const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
      const proposal: Proposal = {
        id: `prop-${runId.slice(-8)}`,
        runId,
        agent: agentUser.name,
        symbol: hit.name,
        path: hit.path,
        line: hit.line,
        insertText,
        targetPreview: hit.preview,
        status: "pending",
        createdAt: now(),
      };
      proposals.set(proposal.id, proposal);
      log.append({ type: "approval.requested", proposalId: proposal.id, at: now() });
      trace.step("propose", `proposed ${lines.length} lines at ${hit.path}:${hit.line} — awaiting human approval`);

      let decision: Proposal;
      try {
        decision = await awaitDecision(
          proposals,
          proposal.id,
          opts.approvalTimeoutMs ?? 120_000,
        );
      } catch (err) {
        // Don't leave a stale pending card in everyone's IDE.
        proposals.set(proposal.id, { ...proposal, status: "rejected", decidedBy: "timeout" });
        throw err;
      }
      if (decision.status === "rejected") {
        log.append({
          type: "approval.rejected",
          proposalId: proposal.id,
          by: decision.decidedBy ?? "unknown",
          at: now(),
        });
        trace.step("decision", `rejected by ${decision.decidedBy ?? "unknown"}`);
        log.append({ type: "run.finished", status: "rejected", at: now() });
        await sleep(300); // let the trace update flush through the relay
        return log.fold();
      }
      log.append({
        type: "approval.granted",
        proposalId: proposal.id,
        by: decision.decidedBy ?? "unknown",
        at: now(),
      });
      trace.step("decision", `approved by ${decision.decidedBy ?? "unknown"}`);

      // ── apply (post-grant) ─────────────────────────────────────────────
      log.append({ type: "step.started", step: "apply", at: now() });
      await typeLines(ytext, hit, lines, opts.typeDelayMs ?? 120);
      proposals.set(proposal.id, { ...proposal, status: "applied", ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}) });
    } else {
      // Direct apply — explicit opt-out of the gate.
      log.append({ type: "step.started", step: "apply", at: now() });
      await typeLines(ytext, hit, lines, opts.typeDelayMs ?? 120);
    }
    log.append({ type: "patch.applied", path: hit.path, at: now() });
    trace.step("apply", `inserted ${lines.length} lines at ${hit.path}:${hit.line}`);
    trace.step("done", "run applied");

    // Give the final update a beat to flush through the relay.
    await sleep(300);
    log.append({ type: "run.finished", status: "applied", at: now() });
    return log.fold();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      trace?.step("failed", message);
      await sleep(300); // best-effort flush of the trace through the relay
    } catch {
      // tracing must never mask the original failure
    }
    log.append({
      type: "run.finished",
      status: "failed",
      error: message,
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

/**
 * Type the patch into the live text. Re-anchors via locateInsertion at apply
 * time: while the run was parked on approval, collaborators may have edited —
 * the preview anchor keeps the insertion glued to the definition.
 */
async function typeLines(
  ytext: Y.Text,
  hit: { line: number; preview: string },
  lines: string[],
  delayMs: number,
): Promise<void> {
  const { offset } = locateInsertion(ytext.toString(), hit);
  let cursor = offset;
  for (const line of lines) {
    ytext.insert(cursor, line + "\n");
    cursor += line.length + 1;
    await sleep(delayMs);
  }
}

/** Park until a human flips the proposal out of pending (or timeout). */
function awaitDecision(
  proposals: Y.Map<Proposal>,
  id: string,
  timeoutMs: number,
): Promise<Proposal> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const p = proposals.get(id);
      if (p && p.status !== "pending") {
        cleanup();
        resolve(p);
        return true;
      }
      return false;
    };
    const observer = () => void check();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`approval timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      proposals.unobserve(observer);
    };
    proposals.observe(observer);
    check(); // subscribe-then-check: the decision may already be in
  });
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
