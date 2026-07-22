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
  symbol: string; // the target definition's name — self-describing for reviewers/UI
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

/**
 * Automated review of a proposal (blueprint doc 07: the Reviewer agent). The
 * reviewer — another room participant — attaches a grounded second opinion so
 * the human approver decides with the call graph's blast-radius analysis in
 * front of them.
 *
 * Reviews live in their OWN `Y.Map("reviews")` keyed by proposalId, NOT inside
 * the Proposal record: the reviewer and the human write concurrently (review
 * vs decision), and LWW-per-key would otherwise let one clobber the other.
 * Separate maps = no contention, and the pair merges by proposalId in the UI.
 */
export type Verdict = "approve" | "concerns" | "reject";

export interface Review {
  id: string;
  proposalId: string;
  reviewer: string; // presence name, e.g. "reviewer (agent)"
  verdict: Verdict;
  summary: string; // one-line assessment
  notes: string[]; // grounded findings (blast radius, consistency, …)
  createdAt: string;
}

export const REVIEWS_KEY = "reviews";

/**
 * A test run's outcome (blueprint doc 07: the Tester agent). The tester runs
 * the workspace's command and records the result in the room's shared
 * `Y.Map("tests")` — so every participant sees pass/fail live and it rides the
 * replay timeline. The web mirrors this shape in TestStatus.tsx.
 */
export interface TestResult {
  id: string;
  runId: string;
  tester: string; // presence name, e.g. "tester (agent)"
  command: string;
  status: "pass" | "fail";
  exitCode: number;
  output: string; // tail of stderr (or stdout), for a peek in the UI
  durationMs: number;
  at: string;
}

export const TESTS_KEY = "tests";
