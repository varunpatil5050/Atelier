import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RunLog, foldEvents, now, type AgentEvent } from "./events.js";

function sampleEvents(runId: string): AgentEvent[] {
  return [
    { type: "run.started", runId, room: "r", goal: "document greet", at: now() },
    { type: "step.started", step: "plan", at: now() },
    { type: "step.started", step: "retrieve", at: now() },
    { type: "retrieval.result", query: "greet", hits: 2, top: "app.ts:4", at: now() },
    { type: "step.started", step: "generate", at: now() },
    { type: "model.call", provider: "scripted", promptHash: "aa", at: now() },
    { type: "model.result", outputHash: "bb", at: now() },
    { type: "step.started", step: "apply", at: now() },
    { type: "patch.proposed", path: "app.ts", line: 4, lines: 6, at: now() },
    { type: "patch.applied", path: "app.ts", at: now() },
    { type: "run.finished", status: "applied", at: now() },
  ];
}

describe("fold", () => {
  it("derives run state from the event stream", () => {
    const state = foldEvents("r1", sampleEvents("r1"));
    expect(state.status).toBe("applied");
    expect(state.goal).toBe("document greet");
    expect(state.steps).toEqual(["plan", "retrieve", "generate", "apply"]);
    expect(state.patchedFiles).toEqual(["app.ts"]);
    expect(state.events).toBe(11);
  });

  it("captures failure with its error", () => {
    const state = foldEvents("r2", [
      { type: "run.started", runId: "r2", room: "r", goal: "document nope", at: now() },
      { type: "run.finished", status: "failed", error: "symbol not found", at: now() },
    ]);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("symbol not found");
  });
});

describe("RunLog JSONL persistence", () => {
  it("appends every event to disk, one JSON object per line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atelier-runs-"));
    const log = new RunLog("run-x", dir);
    for (const ev of sampleEvents("run-x")) log.append(ev);

    const lines = readFileSync(path.join(dir, "run-x.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AgentEvent);
    expect(lines).toHaveLength(11);
    expect(lines[0]!.type).toBe("run.started");
    expect(lines.at(-1)!.type).toBe("run.finished");
    // The on-disk log folds to the same state as the in-memory one.
    expect(foldEvents("run-x", lines)).toEqual(log.fold());
  });
});
