/**
 * Shared agent-reasoning trace (blueprint doc 12 §5 "visual replay" + doc 03
 * §5.4): the agent narrates its steps into the room doc's
 * Y.Array("agent_trace"), so its reasoning is
 *
 *  - visible LIVE to every participant (the IDE renders a feed), and
 *  - REPLAYABLE for free: the array rides the same CRDT updates the relay's
 *    timeline records, so scrubbing a session reconstructs the reasoning
 *    exactly interleaved with the document edits it produced.
 *
 * Entries are plain JSON values (append-only), so cross-replica merging is
 * trivial. The web mirrors this shape in apps/web/src/ide/agentTrace.ts.
 */

import type * as Y from "yjs";

export const AGENT_TRACE_KEY = "agent_trace";

export interface AgentStep {
  runId: string;
  agent: string; // presence name, e.g. "scribe (agent)"
  seq: number; // per-run, 1-based
  step: string; // started|plan|retrieve|generate|propose|decision|apply|done|failed
  detail: string; // human-readable narration
  at: string; // ISO timestamp
}

export class TraceWriter {
  private seq = 0;

  constructor(
    private readonly doc: Y.Doc,
    private readonly runId: string,
    private readonly agent: string,
  ) {}

  step(step: string, detail: string): void {
    const arr = this.doc.getArray<AgentStep>(AGENT_TRACE_KEY);
    arr.push([
      {
        runId: this.runId,
        agent: this.agent,
        seq: ++this.seq,
        step,
        detail,
        at: new Date().toISOString(),
      },
    ]);
  }
}
