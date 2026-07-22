/**
 * The Planner agent (blueprint doc 07: the Planner→Coder→Tester→Reviewer
 * graph — this is the Planner). It turns a free-form goal into a plan and
 * drives the Coder (scribe) to execute it, so the fixed "document <symbol>"
 * grammar gives way to intent like "document all" or "document app.ts".
 *
 * It joins as "planner (agent)", asks the model-gateway to interpret the goal
 * into a directive, expands that directive into concrete tasks via the
 * intelligence plane, and then runs the scribe once per task — each task
 * flowing through the SAME reviewer + human-approval gate as a hand-launched
 * scribe. Planner reasoning and the scribe/reviewer steps it spawns all land
 * in the shared agent_trace, so the whole pipeline is visible live and in
 * replay.
 */

import { randomUUID } from "node:crypto";
import { AtelierProvider, WsConnection } from "@atelier/client";
import type { ModelProvider, PlanDirective } from "./gateway.js";
import type { Intel, SymbolHit } from "./intel.js";
import { runScribe } from "./run.js";
import { TraceWriter } from "./trace.js";

export interface PlanOptions {
  relayUrl: string;
  room: string;
  goal: string;
  provider: ModelProvider;
  intel: Intel;
  serviceToken?: string;
  logDir?: string;
  typeDelayMs?: number;
  requireApproval?: boolean;
  approvalTimeoutMs?: number;
  syncTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface PlanResult {
  runId: string;
  goal: string;
  directive: PlanDirective;
  tasks: string[]; // symbol names, in execution order
  applied: number;
  rejected: number;
  failed: number;
  status: "completed" | "failed";
}

const PLANNER_COLOR = "#f59e0b"; // amber — distinct from scribe (purple) / reviewer (teal)
const DOCUMENTABLE = new Set(["fn", "method"]);

export async function runPlan(opts: PlanOptions): Promise<PlanResult> {
  const runId = `plan-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = opts.logger ?? (() => {});

  const conn = new WsConnection(`${opts.relayUrl.replace(/\/$/, "")}/ws`);
  const plannerUser = { id: `agent-planner-${runId.slice(-8)}`, name: "planner (agent)", color: PLANNER_COLOR };
  const provider = new AtelierProvider(conn, opts.room, plannerUser, {
    ...(opts.serviceToken ? { getToken: async () => opts.serviceToken } : {}),
  });
  provider.awareness.setLocalStateField("user", plannerUser);

  const result: PlanResult = {
    runId,
    goal: opts.goal,
    directive: { action: "document", scope: "symbol" },
    tasks: [],
    applied: 0,
    rejected: 0,
    failed: 0,
    status: "completed",
  };

  let trace: TraceWriter | null = null;
  try {
    conn.connect();
    await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);
    trace = new TraceWriter(provider.doc, runId, plannerUser.name);
    trace.step("started", `goal: ${JSON.stringify(opts.goal)}`);

    // ── plan: interpret the goal via the model-gateway ─────────────────────
    const response = await opts.provider.complete({
      system:
        'You are planner, Atelier\'s planning agent. Respond with JSON: {"action":"document","scope":"symbol"|"file"|"all","target"?:string}.',
      prompt: `Interpret this goal into a plan directive.\nPLAN_GOAL: ${opts.goal}`,
    });
    const directive = JSON.parse(response.text) as PlanDirective;
    result.directive = directive;

    // ── expand: turn the directive into concrete document tasks ────────────
    const tasks = await expand(directive, opts.intel);
    result.tasks = tasks;
    if (tasks.length === 0) {
      trace.step("plan", `no documentable symbols for ${JSON.stringify(opts.goal)}`);
      trace.step("done", "nothing to do");
      await sleep(300);
      return result;
    }
    trace.step(
      "plan",
      `${describeScope(directive)} → ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${tasks.join(", ")}`,
    );
    log(`[planner] ${opts.goal} → ${tasks.length} task(s): ${tasks.join(", ")}`);

    // ── delegate: run the scribe once per task (each gated as usual) ───────
    for (const [i, symbol] of tasks.entries()) {
      trace.step("delegate", `(${i + 1}/${tasks.length}) → scribe: document ${symbol}`);
      const state = await runScribe({
        relayUrl: opts.relayUrl,
        room: opts.room,
        goal: `document ${symbol}`,
        provider: opts.provider,
        intel: opts.intel,
        ...(opts.serviceToken ? { serviceToken: opts.serviceToken } : {}),
        ...(opts.logDir ? { logDir: opts.logDir } : {}),
        ...(opts.typeDelayMs !== undefined ? { typeDelayMs: opts.typeDelayMs } : {}),
        ...(opts.requireApproval !== undefined ? { requireApproval: opts.requireApproval } : {}),
        ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
      });
      if (state.status === "applied") result.applied += 1;
      else if (state.status === "rejected") result.rejected += 1;
      else result.failed += 1;
      log(`[planner] task ${i + 1}/${tasks.length} (${symbol}): ${state.status}`);
    }

    trace.step(
      "done",
      `applied ${result.applied}/${tasks.length}` +
        (result.rejected ? `, ${result.rejected} rejected` : "") +
        (result.failed ? `, ${result.failed} failed` : ""),
    );
    await sleep(300);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = "failed";
    try {
      trace?.step("failed", message);
      await sleep(300);
    } catch {
      // tracing must never mask the original failure
    }
    log(`[planner] failed: ${message}`);
    return result;
  } finally {
    provider.destroy();
  }
}

/** Expand a directive into an ordered, de-duplicated list of symbol names. */
async function expand(directive: PlanDirective, intel: Intel): Promise<string[]> {
  if (directive.scope === "symbol") {
    return directive.target ? [directive.target] : [];
  }
  const path = directive.scope === "file" ? directive.target : undefined;
  const symbols = await intel.symbols(path);
  const documentable = symbols.filter((s: SymbolHit) => DOCUMENTABLE.has(s.kind));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const s of documentable) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      names.push(s.name);
    }
  }
  return names;
}

function describeScope(d: PlanDirective): string {
  if (d.scope === "all") return "document all functions";
  if (d.scope === "file") return `document ${d.target}`;
  return `document ${d.target}`;
}

function waitSynced(provider: AtelierProvider, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay sync timed out after ${timeoutMs}ms`)), timeoutMs);
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
