/**
 * Agent reasoning trace, read side. Mirrors services/conductor/src/trace.ts:
 * agents narrate their steps into Y.Array("agent_trace") in the room doc, so
 * the same data powers the live activity feed AND the replay lane (it rides
 * the recorded CRDT updates).
 */
import type * as Y from "yjs";

export const AGENT_TRACE_KEY = "agent_trace";

export interface AgentStep {
  runId: string;
  agent: string;
  seq: number;
  step: string; // started|plan|retrieve|generate|propose|decision|apply|done|failed
  detail: string;
  at: string; // ISO
}

export function agentTraceOf(doc: Y.Doc): AgentStep[] {
  return doc.getArray<AgentStep>(AGENT_TRACE_KEY).toArray();
}

/**
 * A quiet marker per step. Colour is reserved for genuine outcomes — a step's
 * meaning is carried by its label, not a rainbow of icons. Terminal states get
 * a single muted semantic colour; everything else is a neutral dot.
 */
export function stepBadge(step: string): { icon: string; color: string } {
  const neutral = "var(--text-faint)";
  switch (step) {
    case "done":
      return { icon: "●", color: "var(--green)" };
    case "failed":
      return { icon: "●", color: "var(--red)" };
    case "apply":
    case "decision":
      return { icon: "•", color: "var(--text-dim)" };
    default:
      return { icon: "•", color: neutral };
  }
}
