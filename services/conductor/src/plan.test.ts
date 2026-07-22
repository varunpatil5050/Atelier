import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { ScriptedProvider } from "./gateway.js";
import type { Intel, Refs, SymbolHit } from "./intel.js";
import { AGENT_TRACE_KEY, type AgentStep } from "./trace.js";
import { runPlan } from "./plan.js";

/**
 * Full-stack Planner test: a REAL relay + a human peer seeding the room. The
 * planner decomposes "document all", enumerates symbols from a faked
 * intelligence plane, and drives the scribe once per documentable symbol —
 * the two functions get documented, the class is skipped.
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

const SEED = `export function fmt(label) {
  return \`[\${label}]\`;
}

export function greet(name) {
  return \`Hi, \${name}\`;
}

class Widget {
}
`;

/** Two functions + one class; the planner documents the functions, skips the class. */
class PlanIntel implements Intel {
  private syms: SymbolHit[] = [
    { name: "fmt", kind: "fn", path: "app.ts", line: 1, preview: "export function fmt(label) {" },
    { name: "greet", kind: "fn", path: "app.ts", line: 5, preview: "export function greet(name) {" },
    { name: "Widget", kind: "class", path: "app.ts", line: 9, preview: "class Widget {" },
  ];
  async search(q: string): Promise<SymbolHit[]> {
    return this.syms.filter((s) => s.name === q);
  }
  async symbols(p?: string): Promise<SymbolHit[]> {
    return p ? this.syms.filter((s) => s.path === p) : this.syms;
  }
  async refs(name: string): Promise<Refs> {
    return { name, confidence: "heuristic", count: 1, files: 1, callers: [{ path: "app.ts", line: 20 }] };
  }
}

describe("planner agent against a real relay", () => {
  it("decomposes 'document all' and drives the scribe per function (class skipped)", async () => {
    const room = `plan-${Date.now().toString(36)}`;

    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h1", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");
    const files = peer.doc.getMap<Y.Text>("files");
    const YText = (await import("yjs")).Text;
    peer.doc.transact(() => files.set("app.ts", new YText(SEED)));

    const seenNames = new Set<string>();
    peer.awareness.on("change", () => {
      for (const [, s] of peer.awareness.getStates()) {
        const u = (s as { user?: { name?: string } }).user;
        if (u?.name) seenNames.add(u.name);
      }
    });

    const result = await runPlan({
      relayUrl,
      room,
      goal: "document all",
      provider: new ScriptedProvider(),
      intel: new PlanIntel(),
      typeDelayMs: 5,
      requireApproval: false, // batch: no human gate (the gated path is the scribe's suite)
    });

    expect(result.status).toBe("completed");
    expect(result.directive).toEqual({ action: "document", scope: "all" });
    expect(result.tasks).toEqual(["fmt", "greet"]); // Widget (class) filtered out
    expect(result.applied).toBe(2);

    // Both functions ended up documented in the shared doc.
    const text = files.get("app.ts")!.toString();
    expect(text).toContain("fmt — fn");
    expect(text).toContain("greet — fn");
    // The planner and the scribes it spawned were all visible as participants.
    expect(seenNames.has("planner (agent)")).toBe(true);
    expect(seenNames.has("scribe (agent)")).toBe(true);

    // The planner narrated its orchestration into the shared trace.
    const plannerSteps = peer.doc
      .getArray<AgentStep>(AGENT_TRACE_KEY)
      .toArray()
      .filter((s) => s.runId === result.runId);
    expect(plannerSteps.map((s) => s.step)).toEqual(["started", "plan", "delegate", "delegate", "done"]);
    expect(plannerSteps.every((s) => s.agent === "planner (agent)")).toBe(true);
    expect(plannerSteps.find((s) => s.step === "plan")!.detail).toContain("2 tasks: fmt, greet");
    expect(plannerSteps.find((s) => s.step === "done")!.detail).toContain("applied 2/2");
  });

  it("fails cleanly on an unsupported goal", async () => {
    const room = `plan-bad-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h2", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const result = await runPlan({
      relayUrl,
      room,
      goal: "refactor the universe",
      provider: new ScriptedProvider(),
      intel: new PlanIntel(),
      requireApproval: false,
    });
    expect(result.status).toBe("failed");
    expect(result.applied).toBe(0);
  });
});
