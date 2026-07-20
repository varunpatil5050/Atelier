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

/** Small visual identity per step kind (icon + accent). */
export function stepBadge(step: string): { icon: string; color: string } {
  switch (step) {
    case "started":
      return { icon: "▶", color: "#a855f7" };
    case "plan":
      return { icon: "⌖", color: "#6d9eff" };
    case "retrieve":
      return { icon: "🔍", color: "#14b8a6" };
    case "generate":
      return { icon: "✎", color: "#eab308" };
    case "propose":
      return { icon: "⏳", color: "#f97316" };
    case "decision":
      return { icon: "⚖", color: "#22c55e" };
    case "apply":
      return { icon: "✓", color: "#22c55e" };
    case "done":
      return { icon: "●", color: "#22c55e" };
    case "failed":
      return { icon: "✗", color: "#ef4444" };
    default:
      return { icon: "·", color: "#8b93a1" };
  }
}
