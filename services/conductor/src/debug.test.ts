import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { ScriptedProvider } from "./gateway.js";
import type { Intel, Refs, SymbolHit } from "./intel.js";
import { PROPOSALS_KEY, TESTS_KEY, type Proposal, type TestResult } from "./proposals.js";
import { AGENT_TRACE_KEY, type AgentStep } from "./trace.js";
import {
  locateReturn,
  parseActual,
  parseAssertion,
  parseFailingFrame,
  parseParams,
  runDebugger,
} from "./debug.js";

// ── pure parsers (no relay) ─────────────────────────────────────────────────

const NODE_FAIL = `AssertionError [ERR_ASSERTION]: add(2,3) should be 5

-1 !== 5

    at Object.<anonymous> (/tmp/ws/test.js:4:8)
    at Module._compile (node:internal/modules/cjs/loader:1234:14)
`;

describe("debugger parsers", () => {
  it("finds the failing frame pointing into a room file", () => {
    const frame = parseFailingFrame(NODE_FAIL, (f) => f === "test.js");
    expect(frame).toEqual({ file: "test.js", line: 4 });
  });

  it("skips node-internal frames", () => {
    const frame = parseFailingFrame(NODE_FAIL, (f) => f === "nope.js");
    expect(frame).toBeNull();
  });

  it("parses the assertion call", () => {
    expect(parseAssertion(`assert.strictEqual(add(2, 3), 5, "add(2,3) should be 5");`)).toEqual({
      fn: "add",
      args: [2, 3],
      expected: 5,
    });
  });

  it("parses the actual value from the diff", () => {
    expect(parseActual(NODE_FAIL)).toBe(-1);
  });

  it("parses parameter names", () => {
    expect(parseParams("function add(a, b) {")).toEqual(["a", "b"]);
    expect(parseParams("const f = (x, y) => {")).toEqual(["x", "y"]);
  });

  it("locates the return statement", () => {
    const src = "function add(a, b) {\n  return a - b;\n}\n";
    expect(locateReturn(src, 1)).toEqual({ lineNumber: 2, bodyLine: "  return a - b;", returnExpr: "a - b" });
  });
});

// ── full-stack: the debug loop against a real relay ─────────────────────────

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
  relayProc = spawn(bin, [], { env: { ...process.env, RELAY_ADDR: `:${port}`, RELAY_DATA_DIR: dataDir }, stdio: "ignore" });
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

const MATH_BUGGY = `function add(a, b) {
  return a - b;
}
module.exports = { add };
`;
const TEST_SRC = `const assert = require("assert");
const { add } = require("./math");

assert.strictEqual(add(2, 3), 5, "add(2,3) should be 5");
`;

class FakeIntel implements Intel {
  async search(q: string): Promise<SymbolHit[]> {
    if (q !== "add") return [];
    return [{ name: "add", kind: "fn", path: "math.js", line: 1, preview: "function add(a, b) {" }];
  }
  async symbols(): Promise<SymbolHit[]> {
    return this.search("add");
  }
  async refs(name: string): Promise<Refs> {
    return { name, confidence: "heuristic", count: 1, files: 1, callers: [{ path: "test.js", line: 4 }] };
  }
}

describe("debugger agent against a real relay", () => {
  it("diagnoses a failing test and proposes a verified one-line fix (approved → applied)", async () => {
    const room = `debug-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h1", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");

    // Seed the buggy source + a failing test result the tester would have left.
    const files = peer.doc.getMap<Y.Text>("files");
    peer.doc.transact(() => {
      files.set("math.js", new Y.Text(MATH_BUGGY));
      files.set("test.js", new Y.Text(TEST_SRC));
      peer.doc.getMap<TestResult>(TESTS_KEY).set("t1", {
        id: "t1",
        runId: "test-x",
        tester: "tester (agent)",
        command: "node test.js",
        status: "fail",
        exitCode: 1,
        output: NODE_FAIL,
        durationMs: 30,
        at: new Date().toISOString(),
      });
    });

    // Approve the fix as soon as it's proposed.
    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    const approve = () => {
      const p = [...proposals.values()].find((x) => x.status === "pending");
      if (p) proposals.set(p.id, { ...p, status: "approved", decidedBy: "human" });
    };
    proposals.observe(approve);
    cleanups.push(() => proposals.unobserve(approve));

    const state = await runDebugger({
      relayUrl,
      room,
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
      approvalTimeoutMs: 8_000,
    });

    expect(state.status).toBe("applied");
    expect(state.fn).toBe("add");

    // The bug is fixed in the shared doc.
    const fixed = files.get("math.js")!.toString();
    expect(fixed).toContain("return a + b;");
    expect(fixed).not.toContain("return a - b;");

    // The proposal was a replace, not an insert.
    const applied = [...proposals.values()].find((p) => p.runId === state.runId)!;
    expect(applied.mode).toBe("replace");
    expect(applied.insertText).toBe("  return a + b;");
    expect(applied.targetPreview).toBe("  return a - b;");

    // The debugger narrated its diagnosis grounded in the real assertion.
    const steps = peer.doc
      .getArray<AgentStep>(AGENT_TRACE_KEY)
      .toArray()
      .filter((s) => s.runId === state.runId);
    expect(steps.map((s) => s.step)).toEqual([
      "started", "diagnose", "locate", "repair", "propose", "decision", "apply", "done",
    ]);
    expect(steps.find((s) => s.step === "diagnose")!.detail).toContain("add(2, 3) expected 5, got -1");
    expect(steps.find((s) => s.step === "repair")!.detail).toContain("changing `-` to `+`");
  });

  it("does nothing when there is no failing test", async () => {
    const room = `debug-clean-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h2", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const state = await runDebugger({
      relayUrl,
      room,
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
    });
    expect(state.status).toBe("nothing-to-do");
  });
});
