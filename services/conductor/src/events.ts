/**
 * Event-sourced agent runs (blueprint doc 07 §1): a run is a data structure,
 * not a process — every step, retrieval, model call, and patch is an
 * immutable event, and run state is a fold over the log.
 *
 * v0 persistence: one JSONL file per run under data/agent-runs/. The same
 * events flow to JetStream + the replay timeline later; the shapes are what
 * matter now (crash recovery, audit, and replay all read this log).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export type AgentEvent =
  | { type: "run.started"; runId: string; room: string; goal: string; at: string }
  | { type: "step.started"; step: "plan" | "retrieve" | "generate" | "apply"; at: string }
  | { type: "retrieval.result"; query: string; hits: number; top?: string; at: string }
  | { type: "model.call"; provider: string; promptHash: string; at: string }
  | { type: "model.result"; outputHash: string; at: string }
  | { type: "patch.proposed"; path: string; line: number; lines: number; at: string }
  | { type: "patch.applied"; path: string; at: string }
  | { type: "run.finished"; status: "applied" | "failed"; error?: string; at: string };

export interface RunState {
  runId: string;
  goal: string;
  status: "running" | "applied" | "failed";
  steps: string[];
  patchedFiles: string[];
  error?: string;
  events: number;
}

export class RunLog {
  readonly runId: string;
  readonly events: AgentEvent[] = [];
  private readonly file: string | null;

  constructor(runId: string, dir?: string) {
    this.runId = runId;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${runId}.jsonl`);
    } else {
      this.file = null;
    }
  }

  append(ev: AgentEvent): void {
    this.events.push(ev);
    if (this.file) {
      appendFileSync(this.file, JSON.stringify(ev) + "\n", "utf8");
    }
  }

  /** Fold the log into current run state. */
  fold(): RunState {
    return foldEvents(this.runId, this.events);
  }
}

export function foldEvents(runId: string, events: AgentEvent[]): RunState {
  const state: RunState = {
    runId,
    goal: "",
    status: "running",
    steps: [],
    patchedFiles: [],
    events: events.length,
  };
  for (const ev of events) {
    switch (ev.type) {
      case "run.started":
        state.goal = ev.goal;
        break;
      case "step.started":
        state.steps.push(ev.step);
        break;
      case "patch.applied":
        state.patchedFiles.push(ev.path);
        break;
      case "run.finished":
        state.status = ev.status;
        if (ev.error) state.error = ev.error;
        break;
      default:
        break;
    }
  }
  return state;
}

export function now(): string {
  return new Date().toISOString();
}
