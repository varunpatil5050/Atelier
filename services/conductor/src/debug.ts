/**
 * The Debugger agent (blueprint doc 07: the Reviewer/Debugger roles). It closes
 * the loop: when the Tester reports a failure, the Debugger reads the real
 * assertion and the real source, proposes a one-line fix through the SAME
 * reviewer + human-approval gate as the scribe, and — once applied — the Tester
 * can re-run green.
 *
 * The diagnosis is grounded, not guessed: it follows the stack trace to the
 * failing assertion in the room's source, extracts the inputs + expected value,
 * reads the function under test, and asks the model-gateway for a repair that is
 * *verified* against the assertion (a bounded operator search in the scripted
 * v0; a real model generalizes it behind the same DEBUG_FACTS branch).
 */

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { type DebugOutput, type ModelProvider } from "./gateway.js";
import type { Intel } from "./intel.js";
import { PROPOSALS_KEY, TESTS_KEY, type Proposal, type TestResult } from "./proposals.js";
import { TraceWriter } from "./trace.js";

export interface DebuggerOptions {
  relayUrl: string;
  room: string;
  provider: ModelProvider;
  intel: Intel;
  serviceToken?: string;
  requireApproval?: boolean;
  approvalTimeoutMs?: number;
  syncTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface DebuggerState {
  runId: string;
  status: "proposed" | "applied" | "rejected" | "nothing-to-do" | "unfixable" | "failed";
  fn?: string;
  error?: string;
}

const DEBUGGER_COLOR = "#fb7185"; // rose — distinct from scribe/reviewer/planner/tester

export async function runDebugger(opts: DebuggerOptions): Promise<DebuggerState> {
  const runId = `debug-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = opts.logger ?? (() => {});

  const conn = new WsConnection(`${opts.relayUrl.replace(/\/$/, "")}/ws`);
  const dbgUser = { id: `agent-debugger-${runId.slice(-8)}`, name: "debugger (agent)", color: DEBUGGER_COLOR };
  const provider = new AtelierProvider(conn, opts.room, dbgUser, {
    ...(opts.serviceToken ? { getToken: async () => opts.serviceToken } : {}),
  });
  provider.awareness.setLocalStateField("user", dbgUser);

  const state: DebuggerState = { runId, status: "failed" };
  let trace: TraceWriter | null = null;
  try {
    conn.connect();
    await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);
    trace = new TraceWriter(provider.doc, runId, dbgUser.name);
    trace.step("started", "looking for a failing test to fix");

    // ── diagnose: the most recent failing test result ─────────────────────
    const tests = provider.doc.getMap<TestResult>(TESTS_KEY);
    const failing = [...tests.values()]
      .filter((t) => t.status === "fail")
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    if (!failing) {
      trace.step("diagnose", "no failing test to debug");
      trace.step("done", "nothing to do");
      state.status = "nothing-to-do";
      await sleep(300);
      return state;
    }

    const files = provider.doc.getMap<Y.Text>("files");
    const readFile = (name: string): string | undefined => files.get(name)?.toString();

    const frame = parseFailingFrame(failing.output, (name) => files.has(name));
    if (!frame) {
      throw new Error("couldn't locate the failing assertion in the stack trace");
    }
    const testSrc = readFile(frame.file);
    if (!testSrc) throw new Error(`test file ${frame.file} not in the room`);
    const assertion = parseAssertion(lineAt(testSrc, frame.line));
    if (!assertion) throw new Error(`couldn't parse the assertion at ${frame.file}:${frame.line}`);
    const actual = parseActual(failing.output);
    trace.step(
      "diagnose",
      `${frame.file}:${frame.line} — ${assertion.fn}(${assertion.args.join(", ")}) expected ${assertion.expected}` +
        (actual !== undefined ? `, got ${actual}` : ""),
    );

    // ── locate: the function under test ───────────────────────────────────
    const hits = await opts.intel.search(assertion.fn, 5);
    const hit = hits.find((h) => h.name === assertion.fn) ?? hits[0];
    if (!hit) throw new Error(`intelligence plane doesn't know ${assertion.fn}`);
    const fnSrc = readFile(hit.path);
    if (!fnSrc) throw new Error(`file ${hit.path} not in the room`);
    const ret = locateReturn(fnSrc, hit.line);
    if (!ret) throw new Error(`no single return statement in ${assertion.fn} to repair`);
    trace.step("locate", `${assertion.fn} at ${hit.path}:${hit.line}; return at line ${ret.lineNumber}`);

    // ── repair: ask the gateway for a verified fix ────────────────────────
    const params = parseParams(lineAt(fnSrc, hit.line));
    const response = await opts.provider.complete({
      system:
        'You are debugger, Atelier\'s repair agent. Respond with JSON: {"fixable":boolean,"fixedLine"?:string,"was"?:string,"explanation":string}.',
      prompt:
        "Propose a minimal fix that makes the failing assertion pass.\n" +
        `DEBUG_FACTS: ${JSON.stringify({
          fn: assertion.fn,
          params,
          args: assertion.args,
          expected: assertion.expected,
          actual: actual ?? NaN,
          bodyLine: ret.bodyLine,
          returnExpr: ret.returnExpr,
        })}`,
    });
    const fix = JSON.parse(response.text) as DebugOutput;
    if (!fix.fixable || !fix.fixedLine) {
      trace.step("repair", `can't auto-fix — ${fix.explanation}`);
      trace.step("done", "left for a human");
      log(`[debugger] ${assertion.fn}: unfixable — ${fix.explanation}`);
      state.status = "unfixable";
      state.fn = assertion.fn;
      await sleep(300);
      return state;
    }
    trace.step("repair", fix.explanation);
    log(`[debugger] ${assertion.fn}: ${fix.explanation}`);
    state.fn = assertion.fn;

    const ytext = files.get(hit.path)!;
    if (opts.requireApproval === false) {
      replaceLine(ytext, ret.bodyLine, fix.fixedLine);
      trace.step("apply", `replaced ${hit.path}:${ret.lineNumber} with ${JSON.stringify(fix.fixedLine.trim())}`);
      trace.step("done", "fix applied");
      state.status = "applied";
      await sleep(300);
      return state;
    }

    // ── propose (replace mode) → await human decision → apply ─────────────
    const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
    const proposal: Proposal = {
      id: `prop-${runId.slice(-8)}`,
      runId,
      agent: dbgUser.name,
      symbol: assertion.fn,
      mode: "replace",
      path: hit.path,
      line: ret.lineNumber,
      insertText: fix.fixedLine,
      targetPreview: ret.bodyLine,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    proposals.set(proposal.id, proposal);
    trace.step("propose", `fix ${hit.path}:${ret.lineNumber} — awaiting human approval`);

    let decision: Proposal;
    try {
      decision = await awaitDecision(proposals, proposal.id, opts.approvalTimeoutMs ?? 120_000);
    } catch (err) {
      proposals.set(proposal.id, { ...proposal, status: "rejected", decidedBy: "timeout" });
      throw err;
    }
    if (decision.status === "rejected") {
      trace.step("decision", `rejected by ${decision.decidedBy ?? "unknown"}`);
      trace.step("done", "fix rejected");
      state.status = "rejected";
      await sleep(300);
      return state;
    }
    trace.step("decision", `approved by ${decision.decidedBy ?? "unknown"}`);
    replaceLine(ytext, ret.bodyLine, fix.fixedLine);
    proposals.set(proposal.id, { ...proposal, status: "applied", ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}) });
    trace.step("apply", `replaced ${hit.path}:${ret.lineNumber}`);
    trace.step("done", "fix applied — re-run the tester to confirm");
    state.status = "applied";
    await sleep(300);
    return state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.error = message;
    try {
      trace?.step("failed", message);
      await sleep(300);
    } catch {
      // tracing must never mask the original failure
    }
    log(`[debugger] failed: ${message}`);
    return state;
  } finally {
    provider.destroy();
  }
}

// ── pure parsers (unit-tested) ──────────────────────────────────────────────

/** Find the first stack frame that points into a room file. */
export function parseFailingFrame(
  output: string,
  inRoom: (file: string) => boolean,
): { file: string; line: number } | null {
  const re = /at [^\n]*?\(?([^\s(]+):(\d+):\d+\)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    const base = m[1]!.split("/").pop()!;
    if (inRoom(base)) return { file: base, line: Number(m[2]) };
  }
  return null;
}

/** Parse `assert.strictEqual(fn(a, b), expected, …)` at the failing line. */
export function parseAssertion(line: string): { fn: string; args: number[]; expected: number } | null {
  const m = line.match(/(?:strictEqual|equal|deepStrictEqual)\(\s*([A-Za-z_$][\w$]*)\(([^)]*)\)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const args = m[2]!
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  return { fn: m[1]!, args, expected: Number(m[3]) };
}

/** The `actual` value from a `actual !== expected` assert diff. */
export function parseActual(output: string): number | undefined {
  const m = output.match(/(-?\d+(?:\.\d+)?)\s*!==\s*-?\d+(?:\.\d+)?/);
  return m ? Number(m[1]) : undefined;
}

/** Parameter names from a function's definition line. */
export function parseParams(defLine: string): string[] {
  const m = defLine.match(/\(([^)]*)\)/);
  if (!m || !m[1]!.trim()) return [];
  return m[1]!.split(",").map((s) => s.trim().split(/[:\s=]/)[0]!).filter(Boolean);
}

/** The first `return …;` at or after the definition line (1-based). */
export function locateReturn(
  src: string,
  defLine: number,
): { lineNumber: number; bodyLine: string; returnExpr: string } | null {
  const lines = src.split("\n");
  for (let i = Math.max(defLine - 1, 0); i < lines.length; i++) {
    const rm = lines[i]!.match(/^\s*return\s+(.+?);\s*$/);
    if (rm) return { lineNumber: i + 1, bodyLine: lines[i]!, returnExpr: rm[1]! };
  }
  return null;
}

function lineAt(src: string, line1: number): string {
  return src.split("\n")[line1 - 1] ?? "";
}

/** Replace the line matching oldLine with newLine (anchored by text for drift tolerance). */
function replaceLine(ytext: Y.Text, oldLine: string, newLine: string): boolean {
  const lines = ytext.toString().split("\n");
  const idx = lines.findIndex((l) => l.trim() === oldLine.trim());
  if (idx === -1) return false;
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += lines[i]!.length + 1;
  ytext.doc?.transact(() => {
    ytext.delete(offset, lines[idx]!.length);
    ytext.insert(offset, newLine);
  });
  return true;
}

function awaitDecision(proposals: Y.Map<Proposal>, id: string, timeoutMs: number): Promise<Proposal> {
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
    check();
  });
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
