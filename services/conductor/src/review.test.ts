import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { ScriptedProvider } from "./gateway.js";
import type { Intel, Refs, SymbolHit } from "./intel.js";
import { PROPOSALS_KEY, REVIEWS_KEY, type Proposal, type Review } from "./proposals.js";
import { AGENT_TRACE_KEY, type AgentStep } from "./trace.js";
import { startReviewer } from "./review.js";

/**
 * Full-stack Reviewer test: a REAL relay, a human peer that seeds proposals,
 * and the reviewer agent joining as a participant to attach grounded reviews.
 * The intelligence plane is faked (interface-injected) so the call-graph blast
 * radius is deterministic — the indexer has its own suite.
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

/** Blast radius keyed by symbol: greet is low (2), hotpath is high (9). */
class FakeIntel implements Intel {
  async search(): Promise<SymbolHit[]> {
    return [];
  }
  async refs(name: string): Promise<Refs> {
    if (name === "hotpath") {
      return { name, confidence: "heuristic", count: 9, files: 4, callers: [{ path: "a.ts", line: 1 }] };
    }
    return { name, confidence: "heuristic", count: 2, files: 1, callers: [{ path: "main.ts", line: 5 }] };
  }
}

function docComment(symbol: string): string {
  return [`/**`, ` * ${symbol} — documented.`, ` */`].join("\n");
}

function pending(id: string, symbol: string, insertText: string): Proposal {
  return {
    id,
    runId: `run-${id}`,
    agent: "scribe (agent)",
    symbol,
    path: "main.ts",
    line: 1,
    insertText,
    targetPreview: `export function ${symbol}() {`,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

describe("reviewer agent against a real relay", () => {
  it("attaches grounded reviews: approve on low blast radius, concerns on high", async () => {
    const room = `review-${Date.now().toString(36)}`;

    // A human peer seeds proposals and observes the reviews the agent posts.
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h1", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const handle = await startReviewer({
      relayUrl,
      room,
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
    });
    cleanups.push(() => handle.stop());

    // Two proposals: one safe doc comment, one on a widely-called symbol.
    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    peer.doc.transact(() => {
      proposals.set("prop-safe", pending("prop-safe", "greet", docComment("greet")));
      proposals.set("prop-hot", pending("prop-hot", "hotpath", docComment("hotpath")));
    });

    const reviews = peer.doc.getMap<Review>(REVIEWS_KEY);
    const reviewFor = (proposalId: string): Review | undefined =>
      [...reviews.values()].find((r) => r.proposalId === proposalId);

    await waitFor(() => !!reviewFor("prop-safe") && !!reviewFor("prop-hot"), 8_000, "both reviews posted");

    const safe = reviewFor("prop-safe")!;
    expect(safe.verdict).toBe("approve");
    expect(safe.reviewer).toBe("reviewer (agent)");
    expect(safe.notes.some((n) => n.includes("2 callers across 1 file"))).toBe(true);
    expect(safe.summary).toContain("Safe to apply");

    const hot = reviewFor("prop-hot")!;
    expect(hot.verdict).toBe("concerns");
    expect(hot.notes.some((n) => n.includes("high blast radius"))).toBe(true);
    expect(hot.notes.some((n) => n.includes("all 9 call sites"))).toBe(true);

    expect(handle.reviewedCount()).toBe(2);

    // The reviewer narrated into the SHARED trace — visible live and replayable.
    const steps = peer.doc
      .getArray<AgentStep>(AGENT_TRACE_KEY)
      .toArray()
      .filter((s) => s.agent === "reviewer (agent)");
    expect(steps[0]?.step).toBe("started");
    const reviewSteps = steps.filter((s) => s.step === "review");
    expect(reviewSteps).toHaveLength(2);
    expect(reviewSteps.some((s) => s.detail.includes("greet: approve"))).toBe(true);
    expect(reviewSteps.some((s) => s.detail.includes("hotpath: concerns"))).toBe(true);
  });

  it("reviews each proposal exactly once (idempotent across CRDT churn)", async () => {
    const room = `review-once-${Date.now().toString(36)}`;
    const conn = new WsConnection(`${relayUrl}/ws`);
    const peer = new AtelierProvider(conn, room, { id: "h2", name: "human", color: "#00ff00" });
    cleanups.push(() => peer.destroy());
    conn.connect();
    await waitFor(() => peer.synced, 10_000, "peer synced");

    const handle = await startReviewer({
      relayUrl,
      room,
      provider: new ScriptedProvider(),
      intel: new FakeIntel(),
    });
    cleanups.push(() => handle.stop());

    const proposals = peer.doc.getMap<Proposal>(PROPOSALS_KEY);
    proposals.set("prop-x", pending("prop-x", "greet", docComment("greet")));

    const reviews = peer.doc.getMap<Review>(REVIEWS_KEY);
    await waitFor(() => reviews.size === 1, 8_000, "review posted");

    // Churn the proposals map (unrelated edits fire the observer repeatedly).
    for (let i = 0; i < 5; i++) {
      proposals.set("prop-x", { ...proposals.get("prop-x")!, createdAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(reviews.size).toBe(1); // still exactly one review
    expect(handle.reviewedCount()).toBe(1);
  });
});
