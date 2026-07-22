import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { TESTS_KEY, type TestResult } from "./proposals.js";
import { AGENT_TRACE_KEY, type AgentStep } from "./trace.js";
import { LocalRunner, runTester, type RunResult, type Runner } from "./tester.js";

/**
 * Full-stack Tester test: a REAL relay + a human peer. The tester runs a
 * command (execution faked for determinism, plus one real LocalRunner smoke)
 * and records pass/fail into the room's Y.Map("tests").
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let relayProc: ChildProcess;
let relayUrl: string;
const cleanups: Array<() => void> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else reject(new Error("no port"));
    });
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

beforeAll(async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-relay-"));
  const bin = path.join(binDir, "relay");
  execSync(`go build -o ${JSON.stringify(bin)} atelier.dev/services/collab-relay/cmd/collab-relay`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-data-"));
  relayProc = spawn(bin, [], {
    env: { ...process.env, RELAY_ADDR: `:${port}`, RELAY_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  relayUrl = `ws://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 30_000, "relay healthz");
});

afterAll(() => {
  for (const c of cleanups.reverse()) c();
  relayProc?.kill("SIGTERM");
});

class FakeRunner implements Runner {
  constructor(private readonly res: RunResult) {}
  async run(): Promise<RunResult> {
    return this.res;
  }
}

function peerOf(room: string): AtelierProvider {
  const conn = new WsConnection(`${relayUrl}/ws`);
  const peer = new AtelierProvider(conn, room, { id: "h", name: "human", color: "#00ff00" });
  cleanups.push(() => peer.destroy());
  conn.connect();
  return peer;
}

describe("tester agent against a real relay", () => {
  it("records a passing run into the shared tests map + trace", async () => {
    const room = `test-pass-${Date.now().toString(36)}`;
    const peer = peerOf(room);
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const state = await runTester({
      relayUrl,
      room,
      cmd: "npm test",
      cwd: "/tmp",
      runner: new FakeRunner({ exitCode: 0, stdout: "12 passing", stderr: "", timedOut: false, durationMs: 42 }),
    });

    expect(state.status).toBe("pass");
    expect(state.exitCode).toBe(0);

    const tests = peer.doc.getMap<TestResult>(TESTS_KEY);
    await waitFor(() => tests.size === 1, 5_000, "test result visible to peer");
    const result = [...tests.values()][0]!;
    expect(result.status).toBe("pass");
    expect(result.command).toBe("npm test");
    expect(result.tester).toBe("tester (agent)");

    const steps = peer.doc
      .getArray<AgentStep>(AGENT_TRACE_KEY)
      .toArray()
      .filter((s) => s.runId === state.runId);
    expect(steps.map((s) => s.step)).toEqual(["started", "run", "test", "done"]);
    expect(steps.find((s) => s.step === "test")!.detail).toContain("✓ pass");
  });

  it("records a failing run with the exit code and an error peek", async () => {
    const room = `test-fail-${Date.now().toString(36)}`;
    const peer = peerOf(room);
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const state = await runTester({
      relayUrl,
      room,
      cmd: "node app.js",
      cwd: "/tmp",
      runner: new FakeRunner({
        exitCode: 1,
        stdout: "",
        stderr: "AssertionError: expected 4 to equal 5\n  at app.js:9",
        timedOut: false,
        durationMs: 88,
      }),
    });

    expect(state.status).toBe("fail");
    expect(state.exitCode).toBe(1);

    const tests = peer.doc.getMap<TestResult>(TESTS_KEY);
    await waitFor(() => tests.size === 1, 5_000, "fail result visible");
    const result = [...tests.values()][0]!;
    expect(result.status).toBe("fail");
    expect(result.output).toContain("AssertionError");

    const testStep = peer.doc
      .getArray<AgentStep>(AGENT_TRACE_KEY)
      .toArray()
      .find((s) => s.runId === state.runId && s.step === "test")!;
    expect(testStep.detail).toContain("✗ fail — exit 1");
    expect(testStep.detail).toContain("AssertionError");
  });
});

describe("LocalRunner", () => {
  it("captures real exit codes and output", async () => {
    const r = new LocalRunner();
    const ok = await r.run(`node -e "console.log('hi'); process.exit(0)"`, { cwd: "/tmp", timeoutMs: 10_000 });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hi");

    const bad = await r.run(`node -e "process.exit(3)"`, { cwd: "/tmp", timeoutMs: 10_000 });
    expect(bad.exitCode).toBe(3);
  });

  it("kills a command that overruns the timeout", async () => {
    const r = new LocalRunner();
    const res = await r.run(`node -e "setTimeout(()=>{}, 60000)"`, { cwd: "/tmp", timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });
});
