"use client";

import { useEffect, useState } from "react";
import type { AtelierProvider } from "@atelier/client";

/**
 * Human-in-the-loop review of agent patches (blueprint doc 07 §4). Agents
 * write proposals into Y.Map("proposals"); this panel shows pending ones to
 * every participant and writes the decision back — the agent applies only
 * after a grant. Mirrors services/conductor/src/proposals.ts.
 *
 * When the Reviewer agent is running it attaches a grounded second opinion
 * into Y.Map("reviews") (keyed by proposalId); we surface it on the card so
 * the human decides with the call graph's blast-radius analysis in view.
 */
interface Proposal {
  id: string;
  runId: string;
  agent: string;
  symbol?: string;
  path: string;
  line: number;
  insertText: string;
  targetPreview: string;
  status: "pending" | "approved" | "rejected" | "applied";
  decidedBy?: string;
  createdAt: string;
}

type Verdict = "approve" | "concerns" | "reject";

interface Review {
  id: string;
  proposalId: string;
  reviewer: string;
  verdict: Verdict;
  summary: string;
  notes: string[];
  createdAt: string;
}

const PROPOSALS_KEY = "proposals";
const REVIEWS_KEY = "reviews";

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "✓ approve",
  concerns: "⚠ concerns",
  reject: "✕ reject",
};

export default function ProposalPanel({
  provider,
  deciderName,
}: {
  provider: AtelierProvider;
  deciderName: string;
}) {
  const [pending, setPending] = useState<Proposal[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);

  useEffect(() => {
    const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
    const reviewMap = provider.doc.getMap<Review>(REVIEWS_KEY);

    const refreshProposals = () => {
      setPending(
        [...proposals.values()]
          .filter((p) => p.status === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    };
    const refreshReviews = () => setReviews([...reviewMap.values()]);

    proposals.observe(refreshProposals);
    reviewMap.observe(refreshReviews);
    refreshProposals();
    refreshReviews();
    return () => {
      proposals.unobserve(refreshProposals);
      reviewMap.unobserve(refreshReviews);
    };
  }, [provider]);

  const decide = (p: Proposal, status: "approved" | "rejected") => {
    const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
    const current = proposals.get(p.id);
    if (!current || current.status !== "pending") return; // someone beat us
    proposals.set(p.id, { ...current, status, decidedBy: deciderName });
  };

  if (pending.length === 0) return null;

  return (
    <div className="proposal-stack">
      {pending.map((p) => {
        const review = reviews.find((r) => r.proposalId === p.id);
        return (
          <div key={p.id} className="proposal-card">
            <div className="proposal-head">
              <span className="proposal-agent">{p.agent}</span>
              <span className="proposal-target">
                wants to insert {p.insertText.split("\n").length} lines at {p.path}:{p.line}
              </span>
            </div>
            <pre className="proposal-code">{p.insertText}</pre>
            <div className="proposal-context">
              above: <code>{p.targetPreview}</code>
            </div>

            {review ? (
              <div className={`proposal-review verdict-${review.verdict}`}>
                <div className="review-head">
                  <span className="review-verdict">{VERDICT_LABEL[review.verdict]}</span>
                  <span className="review-by">{review.reviewer}</span>
                </div>
                <div className="review-summary">{review.summary}</div>
                {review.notes.length > 0 && (
                  <ul className="review-notes">
                    {review.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="proposal-review review-pending">⚖ awaiting reviewer…</div>
            )}

            <div className="proposal-actions">
              <button className="proposal-approve" onClick={() => decide(p, "approved")}>
                Approve
              </button>
              <button className="proposal-reject" onClick={() => decide(p, "rejected")}>
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
