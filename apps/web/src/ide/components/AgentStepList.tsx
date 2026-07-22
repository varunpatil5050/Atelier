"use client";

import { stepBadge, type AgentStep } from "../agentTrace";

/** "scribe (agent)" → "scribe" — a compact label for the shared feed. */
function shortAgent(name: string): string {
  return name.replace(/\s*\(agent\)\s*$/, "");
}

/**
 * Presentational list of agent reasoning steps — shared by the live activity
 * feed (IDE sidebar) and the replay lane, so a session looks the same live
 * and when scrubbed back.
 */
export default function AgentStepList({
  steps,
  highlightLast = false,
}: {
  steps: AgentStep[];
  highlightLast?: boolean;
}) {
  return (
    <ul className="agent-steps">
      {steps.map((s, i) => {
        const badge = stepBadge(s.step);
        const isLast = highlightLast && i === steps.length - 1;
        return (
          <li
            key={`${s.runId}:${s.seq}`}
            className={isLast ? "agent-step current" : "agent-step"}
          >
            <span className="agent-step-icon" style={{ color: badge.color }}>
              {badge.icon}
            </span>
            <span className="agent-step-body">
              <span className="agent-step-kind" style={{ color: badge.color }}>
                {s.step}
                <span className="agent-step-agent">{shortAgent(s.agent)}</span>
              </span>
              <span className="agent-step-detail">{s.detail}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
