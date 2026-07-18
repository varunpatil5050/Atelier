"use client";

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { AtelierProvider } from "@atelier/client";

/**
 * Human-in-the-loop review of agent patches (blueprint doc 07 §4). Agents
 * write proposals into Y.Map("proposals"); this panel shows pending ones to
 * every participant and writes the decision back — the agent applies only
 * after a grant. Mirrors services/conductor/src/proposals.ts.
 */
interface Proposal {
  id: string;
  runId: string;
  agent: string;
  path: string;
  line: number;
  insertText: string;
  targetPreview: string;
  status: "pending" | "approved" | "rejected" | "applied";
  decidedBy?: string;
  createdAt: string;
}

const PROPOSALS_KEY = "proposals";

export default function ProposalPanel({
  provider,
  deciderName,
}: {
  provider: AtelierProvider;
  deciderName: string;
}) {
  const [pending, setPending] = useState<Proposal[]>([]);

  useEffect(() => {
    const proposals = provider.doc.getMap<Proposal>(PROPOSALS_KEY);
    const refresh = () => {
      const list = [...proposals.values()]
        .filter((p) => p.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setPending(list);
    };
    proposals.observe(refresh);
    refresh();
    return () => proposals.unobserve(refresh);
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
      {pending.map((p) => (
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
          <div className="proposal-actions">
            <button className="proposal-approve" onClick={() => decide(p, "approved")}>
              Approve
            </button>
            <button className="proposal-reject" onClick={() => decide(p, "rejected")}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
