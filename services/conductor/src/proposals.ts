/**
 * Agent patch proposals (blueprint doc 07 §4, doc 03 §5.4): agents never
 * apply directly by default — they write a proposal into the room's shared
 * `Y.Map("proposals")`, humans decide in the IDE, and the agent applies only
 * after a grant.
 *
 * Living in the CRDT (not a side channel) buys: every participant sees the
 * same pending proposal, decisions survive refreshes, and the map doubles as
 * an in-document audit trail. Records are plain JSON values replaced
 * wholesale per transition (LWW per key), so cross-replica merging stays
 * trivial. The web IDE mirrors this shape in ProposalPanel.tsx.
 */

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface Proposal {
  id: string;
  runId: string;
  agent: string; // presence name, e.g. "scribe (agent)"
  path: string;
  line: number; // 1-based anchor line of the target definition
  /** Full text the agent wants to insert (already indented, newline-joined). */
  insertText: string;
  /** The target definition's first line, for context in the review UI. */
  targetPreview: string;
  status: ProposalStatus;
  decidedBy?: string; // human's presence name, set with approved/rejected
  createdAt: string;
}

export const PROPOSALS_KEY = "proposals";
