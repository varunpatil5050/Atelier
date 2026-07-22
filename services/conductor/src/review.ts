/**
 * The Reviewer agent (blueprint doc 07: the Planner→Coder→Tester→Reviewer
 * graph — this is the Reviewer). Unlike the scribe (a one-shot task), the
 * reviewer is a long-running room participant that watches for proposals and
 * attaches a grounded second opinion, so the human approver decides with the
 * call graph's blast-radius analysis in front of them.
 *
 * It joins as "reviewer (agent)" over the same @atelier/client as everyone
 * else, observes Y.Map("proposals"), and for each pending, not-yet-reviewed
 * proposal it: pulls the target's callers from the intelligence plane, asks
 * the model-gateway to score it, writes a Review into Y.Map("reviews"), and
 * narrates a "review" step into the shared agent_trace (live + replayable).
 *
 * Reviews land in their own map, not on the Proposal record — reviewer and
 * human write concurrently, so separate keys avoid LWW clobbering (see
 * proposals.ts).
 */

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { contentHash, type ModelProvider, type ReviewOutput } from "./gateway.js";
import type { Intel } from "./intel.js";
import { PROPOSALS_KEY, REVIEWS_KEY, type Proposal, type Review } from "./proposals.js";
import { TraceWriter } from "./trace.js";

export interface ReviewerOptions {
  relayUrl: string; // ws://host:port (no /ws suffix)
  room: string;
  provider: ModelProvider;
  intel: Intel;
  serviceToken?: string;
  syncTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface ReviewerHandle {
  /** How many reviews this session has posted. */
  reviewedCount(): number;
  /** Leave the room and stop watching. */
  stop(): void;
}

const REVIEWER_COLOR = "#2dd4bf"; // teal — distinct from the scribe's purple

export async function startReviewer(opts: ReviewerOptions): Promise<ReviewerHandle> {
  const runId = `rev-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = opts.logger ?? (() => {});

  const conn = new WsConnection(`${opts.relayUrl.replace(/\/$/, "")}/ws`);
  const reviewerUser = { id: `agent-reviewer-${runId.slice(-8)}`, name: "reviewer (agent)", color: REVIEWER_COLOR };
  const provider = new AtelierProvider(conn, opts.room, reviewerUser, {
    ...(opts.serviceToken ? { getToken: async () => opts.serviceToken } : {}),
  });
  provider.awareness.setLocalStateField("user", reviewerUser);

  conn.connect();
  await waitSynced(provider, opts.syncTimeoutMs ?? 10_000);

  const trace = new TraceWriter(provider.doc, runId, reviewerUser.name);
  trace.step("started", "watching proposals for review");

  const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
  const reviews = provider.doc.getMap<Review>(REVIEWS_KEY);

  const handled = new Set<string>(); // proposalIds we've reviewed or are reviewing
  let count = 0;

  const alreadyReviewed = (proposalId: string): boolean => {
    for (const r of reviews.values()) if (r.proposalId === proposalId) return true;
    return false;
  };

  const reviewOne = async (p: Proposal): Promise<void> => {
    if (handled.has(p.id) || alreadyReviewed(p.id)) return;
    handled.add(p.id);
    try {
      // Ground the review in the call graph: how far does this symbol reach?
      const refs = await opts.intel.refs(p.symbol);
      const prompt = buildReviewPrompt(p, refs.count, refs.files);
      const response = await opts.provider.complete({
        system:
          'You are reviewer, Atelier\'s code-review agent. Respond with JSON: {"verdict": "approve"|"concerns"|"reject", "summary": string, "notes": string[]}.',
        prompt,
      });
      const out = JSON.parse(response.text) as ReviewOutput;

      const review: Review = {
        id: `review-${runId.slice(-8)}-${count + 1}`,
        proposalId: p.id,
        reviewer: reviewerUser.name,
        verdict: out.verdict,
        summary: out.summary,
        notes: out.notes,
        createdAt: new Date().toISOString(),
      };
      reviews.set(review.id, review);
      count += 1;
      trace.step("review", `${p.symbol}: ${out.verdict} — ${out.summary}`);
      log(
        `[reviewer] ${p.id} (${p.symbol}): ${out.verdict} — ${out.summary} ` +
          `[prompt ${contentHash(prompt)}]`,
      );
    } catch (err) {
      // A failed review must not wedge the watcher; let a human decide unaided.
      handled.delete(p.id);
      log(`[reviewer] failed to review ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const scan = (): void => {
    for (const p of proposals.values()) {
      if (p.status === "pending") void reviewOne(p);
    }
  };

  const observer = () => scan();
  proposals.observe(observer);
  scan(); // subscribe-then-check: proposals may already be present

  return {
    reviewedCount: () => count,
    stop: () => {
      proposals.unobserve(observer);
      trace.step("done", `reviewed ${count} proposal${count === 1 ? "" : "s"}`);
      // Give the final trace update a beat to flush, then leave.
      setTimeout(() => provider.destroy(), 200);
    },
  };
}

function buildReviewPrompt(p: Proposal, callers: number, callerFiles: number): string {
  const facts = {
    symbol: p.symbol,
    path: p.path,
    line: p.line,
    insertLines: p.insertText.split("\n").length,
    isDocComment: p.insertText.trimStart().startsWith("/**"),
    namesSymbol: p.insertText.includes(p.symbol),
    callers,
    callerFiles,
  };
  return [
    "Review this proposed patch for safety and consistency.",
    `REVIEW_FACTS: ${JSON.stringify(facts)}`,
    'Respond with JSON: {"verdict": "approve"|"concerns"|"reject", "summary": string, "notes": string[]}',
  ].join("\n");
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
