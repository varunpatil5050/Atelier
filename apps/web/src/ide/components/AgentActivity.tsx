"use client";

import { useEffect, useState } from "react";
import type { AtelierProvider } from "@atelier/client";
import { AGENT_TRACE_KEY, type AgentStep } from "../agentTrace";
import AgentStepList from "./AgentStepList";

const MAX_LIVE_STEPS = 8;

/**
 * Live agent-reasoning feed: renders the tail of the room's shared
 * agent_trace array as agents work. Appears only once an agent has acted.
 */
export default function AgentActivity({ provider }: { provider: AtelierProvider }) {
  const [steps, setSteps] = useState<AgentStep[]>([]);

  useEffect(() => {
    const arr = provider.doc.getArray<AgentStep>(AGENT_TRACE_KEY);
    const refresh = () => setSteps(arr.toArray().slice(-MAX_LIVE_STEPS));
    arr.observe(refresh);
    refresh();
    return () => arr.unobserve(refresh);
  }, [provider]);

  if (steps.length === 0) return null;

  return (
    <div className="agent-activity">
      <div className="sidebar-head">
        <span>Agent activity</span>
      </div>
      <AgentStepList steps={steps} highlightLast />
    </div>
  );
}
