/**
 * The Tester agent (blueprint doc 07: the Planner→Coder→Tester→Reviewer graph
 * — this is the Tester). It runs the workspace's code or test command and
 * reports pass/fail into the room, so a change can be validated by execution,
 * not just by review.
 *
 * Execution sits behind a `Runner` seam — the same interface-ladder pattern as
 * the workspace-host Runtime: `LocalRunner` runs the command on the dev machine
 * now; a sandbox runner that executes inside the workspace's Docker container
 * (blueprint doc 05 §8 structured runs) drops in behind the same interface,
 * unchanged call sites.
 *
 * The tester joins as "tester (agent)", runs the command, writes a TestResult
 * into the room's shared `Y.Map("tests")` (so every participant sees it live
 * and it rides the replay timeline), and narrates a pass/fail step into the
 * shared agent_trace.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { TESTS_KEY, type TestResult } from "./proposals.js";
import { TraceWriter } from "./trace.js";

export interface RunResult {
  exitCode: number; // -1 when killed / never started
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Executes a command and returns its outcome. The seam that lets the tester
 * move from the host to a container without touching the agent. */
export interface Runner {
  run(cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<RunResult>;
}

const MAX_CAPTURE = 16 * 1024; // keep the last 16 KiB of each stream

/** Runs the command via a shell on the dev machine (the host rung). */
export class LocalRunner implements Runner {
  run(cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<RunResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(cmd, { cwd: opts.cwd, shell: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (buf: string, chunk: Buffer): string =>
        (buf + chunk.toString()).slice(-MAX_CAPTURE);
      child.stdout?.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr?.on("data", (c: Buffer) => (stderr = cap(stderr, c)));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: stderr || "spawn failed", timedOut, durationMs: Date.now() - started });
      });
    });
  }
}

export interface TesterOptions {
  relayUrl: string;
  room: string;
  cmd: string;
  cwd: string;
  runner?: Runner;
  serviceToken?: string;
  timeoutMs?: number;
  syncTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface TesterState {
  runId: string;
  command: string;
  status: "pass" | "fail";
  exitCode: number;
}

const TESTER_COLOR = "#38bdf8"; // sky — distinct from planner/scribe/reviewer

export async function runTester(opts: TesterOptions): Promise<TesterState> {
  const runId = `test-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = opts.logger ?? (() => {});
  const runner = opts.runner ?? new LocalRunner();

  const conn = new WsConnection(`${opts.relayUrl.replace(/\/$/, "")}/ws`);
  const testerUser = { id: `agent-tester-${runId.slice(-8)}`, name: "tester (agent)", color: TESTER_COLOR };
  const provider = new AtelierProvider(conn, opts.room, testerUser, {
    ...(opts.serviceToken ? { getToken: async () => opts.serviceToken } : {}),
  });
  provider.awareness.setLocalStateField("user", testerUser);

  let trace: TraceWriter | null = null;
  try {
    conn.connect();
    await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);
    trace = new TraceWriter(provider.doc, runId, testerUser.name);
    trace.step("started", `command: ${JSON.stringify(opts.cmd)}`);
    trace.step("run", `executing in ${opts.cwd}`);

    const res = await runner.run(opts.cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 60_000 });
    const status: "pass" | "fail" = res.exitCode === 0 ? "pass" : "fail";

    const result: TestResult = {
      id: `testresult-${runId.slice(-8)}`,
      runId,
      tester: testerUser.name,
      command: opts.cmd,
      status,
      exitCode: res.exitCode,
      output: tail(res.stderr || res.stdout, 1200),
      durationMs: res.durationMs,
      at: new Date().toISOString(),
    };
    provider.doc.getMap<TestResult>(TESTS_KEY).set(result.id, result);

    const suffix = res.timedOut ? " (timed out)" : "";
    trace.step(
      "test",
      status === "pass"
        ? `✓ pass — exit 0 in ${res.durationMs}ms${suffix}`
        : `✗ fail — exit ${res.exitCode}${suffix}: ${firstLine(res.stderr || res.stdout)}`,
    );
    trace.step("done", `${status} (${res.durationMs}ms)`);
    log(`[tester] ${opts.cmd} → ${status} (exit ${res.exitCode}, ${res.durationMs}ms)`);

    await sleep(300); // let the trace + result flush through the relay
    return { runId, command: opts.cmd, status, exitCode: res.exitCode };
  } finally {
    provider.destroy();
  }
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 160 ? line.slice(0, 160) + "…" : line;
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
