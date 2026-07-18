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
import { PROPOSALS_KEY, type Proposal } from "./proposals.js";
import { locateInsertion, runScribe } from "./run.js";

/**
 * Full-stack agent test: a REAL relay, a human-peer client seeding the room,
 * and the scribe agent joining as a participant to type its patch. The
 * intelligence plane is faked (interface-injected) to keep the test fast —
 * the indexer has its own suite.
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

const SEED = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

greet("world");
`;

class FakeIntel implements Intel {
  async search(): Promise<SymbolHit[]> {
    return [
      {
        name: "greet",
        kind: "fn",
        path: "main.ts",
        line: 1,
        preview: "export function greet(name: string): string {",
      },
    ];
  }
  async refs(): Promise<Refs> {
    return {
      name: "greet",
      confidence: "heuristic",
      count: 1,
      files: 1,
      callers: [{ path: "main.ts", line: 5 }],
    };
  }
}

describe("scribe agent against a real relay", () => {
  it("joins as a participant and types a doc comment into the shared doc", async () => {
    const room = `agent-${Date.now().toString(36)}`;

    // A "human" peer seeds the room and will observe the agent's edits.
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h1", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");
    const files = peer.doc.getMap<Y.Text>("files");
    const YText = (await import("yjs")).Text;
    peer.doc.transact(() => files.set("main.ts", new YText(SEED)));

    // Track presence: the agent must appear and later disappear.
    const seenNames = new Set<string>();
    peer.awareness.on("change", () => {
      for (const [, s] of peer.awareness.getStates()) {
        const u = (s as { user?: { name?: string } }).user;
        if (u?.name) seenNames.add(u.name);
      }
    });

    const state = await runScribe({
      relayUrl,
      room,
      goal: "document greet",
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
      typeDelayMs: 5, // fast in tests
      requireApproval: false, // the gated paths have their own tests below
    });

    expect(state.status).toBe("applied");
    expect(state.steps).toEqual(["plan", "retrieve", "generate", "apply"]);
    expect(state.patchedFiles).toEqual(["main.ts"]);

    // The peer's replica converged on the agent's patch.
    await waitFor(
      () => files.get("main.ts")!.toString().includes("documented by scribe"),
      5_000,
      "agent patch visible to the peer",
    );
    const text = files.get("main.ts")!.toString();
    expect(text).toContain("greet — fn, defined at main.ts:1");
    expect(text).toContain("Called 1 time across 1 file");
    // Comment sits ABOVE the definition.
    expect(text.indexOf("/**")).toBeLessThan(text.indexOf("export function greet"));
    // The agent was visible as a participant while it worked.
    expect(seenNames.has("scribe (agent)")).toBe(true);
  });

  it("approval gate: parks on the proposal, applies after a human approves", async () => {
    const room = `agent-appr-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h2", name: "reviewer", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");
    const files = peer.doc.getMap<Y.Text>("files");
    const YText = (await import("yjs")).Text;
    peer.doc.transact(() => files.set("main.ts", new YText(SEED)));

    // The "human": approve the proposal as soon as it appears.
    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    const approver = setInterval(() => {
      for (const [id, p] of proposals.entries()) {
        if (p.status === "pending") {
          expect(p.agent).toBe("scribe (agent)");
          expect(p.insertText).toContain("documented by scribe");
          proposals.set(id, { ...p, status: "approved", decidedBy: "reviewer" });
        }
      }
    }, 50);
    cleanups.push(() => clearInterval(approver));

    const state = await runScribe({
      relayUrl,
      room,
      goal: "document greet",
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
      typeDelayMs: 5,
      requireApproval: true,
      approvalTimeoutMs: 10_000,
    });

    expect(state.status).toBe("applied");
    expect(state.decidedBy).toBe("reviewer");
    expect(state.steps).toEqual(["plan", "retrieve", "generate", "propose", "apply"]);
    await waitFor(
      () => files.get("main.ts")!.toString().includes("documented by scribe"),
      5_000,
      "approved patch visible to the peer",
    );
    // The proposal record ends life as an audit entry: applied + who decided.
    const final = [...proposals.values()].find((p) => p.runId === state.runId)!;
    expect(final.status).toBe("applied");
    expect(final.decidedBy).toBe("reviewer");
  });

  it("approval gate: a rejection leaves the document untouched", async () => {
    const room = `agent-rej-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h3", name: "skeptic", color: "#ff0000" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");
    const files = peer.doc.getMap<Y.Text>("files");
    const YText = (await import("yjs")).Text;
    peer.doc.transact(() => files.set("main.ts", new YText(SEED)));

    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    const rejecter = setInterval(() => {
      for (const [id, p] of proposals.entries()) {
        if (p.status === "pending") {
          proposals.set(id, { ...p, status: "rejected", decidedBy: "skeptic" });
        }
      }
    }, 50);
    cleanups.push(() => clearInterval(rejecter));

    const state = await runScribe({
      relayUrl,
      room,
      goal: "document greet",
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
      typeDelayMs: 5,
      requireApproval: true,
      approvalTimeoutMs: 10_000,
    });

    expect(state.status).toBe("rejected");
    expect(state.decidedBy).toBe("skeptic");
    expect(state.patchedFiles).toEqual([]);
    expect(files.get("main.ts")!.toString()).toBe(SEED); // untouched
  });

  it("approval gate: times out when nobody decides, marking the proposal", async () => {
    const room = `agent-to-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h4", name: "afk", color: "#888888" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");
    const files = peer.doc.getMap<Y.Text>("files");
    const YText = (await import("yjs")).Text;
    peer.doc.transact(() => files.set("main.ts", new YText(SEED)));

    const state = await runScribe({
      relayUrl,
      room,
      goal: "document greet",
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
      typeDelayMs: 5,
      requireApproval: true,
      approvalTimeoutMs: 500, // nobody is coming
    });

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/approval timed out/);
    expect(files.get("main.ts")!.toString()).toBe(SEED);
    // No stale pending card left behind for the IDE.
    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    await waitFor(
      () => [...proposals.values()].every((p) => p.status !== "pending"),
      5_000,
      "timed-out proposal marked",
    );
  });

  it("fails cleanly when the symbol does not exist", async () => {
    const room = `agent-miss-${Date.now().toString(36)}`;
    const emptyIntel: Intel = {
      search: async () => [],
      refs: async () => ({ name: "", confidence: "heuristic", count: 0, files: 0, callers: [] }),
    };
    const state = await runScribe({
      relayUrl,
      room,
      goal: "document nothing",
      provider: new ScriptedProvider(),
      intel: emptyIntel,
      typeDelayMs: 1,
    });
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/no symbol found/);
  });
});

describe("locateInsertion", () => {
  const text = "const a = 1;\n  export function greet() {\n  }\n";

  it("anchors on the preview line and captures indentation", () => {
    const { offset, indent } = locateInsertion(text, {
      line: 99, // wrong on purpose — preview anchor must win
      preview: "export function greet() {",
    });
    expect(offset).toBe("const a = 1;\n".length);
    expect(indent).toBe("  ");
  });

  it("falls back to the indexed line when the preview is not found", () => {
    const { offset } = locateInsertion(text, { line: 1, preview: "not in file" });
    expect(offset).toBe(0);
  });
});
