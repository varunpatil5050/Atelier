import { describe, expect, it } from "vitest";
import {
  ScriptedProvider,
  contentHash,
  parsePlanDirective,
  type DebugFacts,
  type DebugOutput,
  type PlanDirective,
  type ReviewFacts,
  type ReviewOutput,
  type ScribeFacts,
} from "./gateway.js";

function promptWith(facts: Partial<ScribeFacts>): string {
  const full: ScribeFacts = {
    symbol: "greet",
    kind: "fn",
    path: "app.ts",
    line: 4,
    callers: 3,
    callerFiles: 1,
    topCaller: "welcome",
    preview: "export function greet(name: string) {",
    ...facts,
  };
  return `You are scribe. Produce a doc comment.\nFACTS: ${JSON.stringify(full)}\nRespond with JSON.`;
}

describe("ScriptedProvider", () => {
  it("is deterministic: same prompt, same output, zero network", async () => {
    const p = new ScriptedProvider();
    const a = await p.complete({ system: "s", prompt: promptWith({}) });
    const b = await p.complete({ system: "s", prompt: promptWith({}) });
    expect(a).toEqual(b);
    expect(a.provider).toBe("scripted");
  });

  it("emits parseable JSON whose comment reflects the facts", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: promptWith({}) });
    const { comment } = JSON.parse(res.text) as { comment: string };
    expect(comment).toContain("greet — fn, defined at app.ts:4");
    expect(comment).toContain("Called 3 times across 1 file");
    expect(comment).toContain("welcome");
    expect(comment.startsWith("/**")).toBe(true);
    expect(comment.endsWith("*/")).toBe(true);
  });

  it("phrases zero-caller and container cases correctly", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({
      system: "s",
      prompt: promptWith({ callers: 0, callerFiles: 0, container: "Room", kind: "method" }),
    });
    const { comment } = JSON.parse(res.text) as { comment: string };
    expect(comment).toContain("method on Room");
    expect(comment).toContain("Not referenced anywhere yet.");
  });

  it("rejects prompts without a FACTS block", async () => {
    const p = new ScriptedProvider();
    await expect(p.complete({ system: "s", prompt: "no facts here" })).rejects.toThrow(
      /FACTS/,
    );
  });
});

function reviewPromptWith(facts: Partial<ReviewFacts>): string {
  const full: ReviewFacts = {
    symbol: "greet",
    path: "app.ts",
    line: 4,
    insertLines: 6,
    isDocComment: true,
    namesSymbol: true,
    callers: 2,
    callerFiles: 1,
    ...facts,
  };
  return `You are reviewer. Score this patch.\nREVIEW_FACTS: ${JSON.stringify(full)}\nRespond with JSON.`;
}

describe("ScriptedProvider — reviewer branch", () => {
  it("approves a low-blast-radius doc comment, grounded in the call graph", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: reviewPromptWith({ callers: 2, callerFiles: 1 }) });
    const out = JSON.parse(res.text) as ReviewOutput;
    expect(out.verdict).toBe("approve");
    expect(out.summary).toContain("Safe to apply");
    expect(out.notes.some((n) => n.includes("2 callers across 1 file"))).toBe(true);
    expect(out.notes.some((n) => n.includes("low blast radius"))).toBe(true);
  });

  it("raises concerns when blast radius is high", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: reviewPromptWith({ callers: 9, callerFiles: 4 }) });
    const out = JSON.parse(res.text) as ReviewOutput;
    expect(out.verdict).toBe("concerns");
    expect(out.notes.some((n) => n.includes("high blast radius"))).toBe(true);
    expect(out.notes.some((n) => n.includes("all 9 call sites"))).toBe(true);
  });

  it("flags a proposal that doesn't reference its target symbol", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: reviewPromptWith({ namesSymbol: false }) });
    const out = JSON.parse(res.text) as ReviewOutput;
    expect(out.verdict).toBe("concerns");
    expect(out.notes.some((n) => n.includes("anchored to the right definition"))).toBe(true);
  });

  it("is deterministic and never auto-rejects (a human decides)", async () => {
    const p = new ScriptedProvider();
    const a = await p.complete({ system: "s", prompt: reviewPromptWith({ callers: 20 }) });
    const b = await p.complete({ system: "s", prompt: reviewPromptWith({ callers: 20 }) });
    expect(a).toEqual(b);
    expect((JSON.parse(a.text) as ReviewOutput).verdict).not.toBe("reject");
  });
});

describe("parsePlanDirective (planner branch)", () => {
  it("decomposes 'document all' / 'everything' into an all-scope directive", () => {
    for (const g of ["document all", "document everything", "document all functions", "document all symbols"]) {
      expect(parsePlanDirective(g)).toEqual({ action: "document", scope: "all" });
    }
  });

  it("routes a filename to file scope", () => {
    expect(parsePlanDirective("document app.ts")).toEqual({ action: "document", scope: "file", target: "app.ts" });
    expect(parsePlanDirective("document src/util.go")).toEqual({
      action: "document",
      scope: "file",
      target: "src/util.go",
    });
  });

  it("routes a bare identifier to symbol scope", () => {
    expect(parsePlanDirective("document greet")).toEqual({ action: "document", scope: "symbol", target: "greet" });
  });

  it("throws on an unsupported goal", () => {
    expect(() => parsePlanDirective("refactor everything")).toThrow(/unsupported goal/);
  });

  it("is reachable through the ScriptedProvider PLAN_GOAL branch", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: "plan this\nPLAN_GOAL: document all\ndone" });
    expect(JSON.parse(res.text) as PlanDirective).toEqual({ action: "document", scope: "all" });
  });
});

function debugPromptWith(facts: Partial<DebugFacts>): string {
  const full: DebugFacts = {
    fn: "add",
    params: ["a", "b"],
    args: [2, 3],
    expected: 5,
    actual: -1,
    bodyLine: "  return a - b;",
    returnExpr: "a - b",
    ...facts,
  };
  return `Fix this.\nDEBUG_FACTS: ${JSON.stringify(full)}\ndone`;
}

describe("ScriptedProvider — debugger branch", () => {
  it("repairs an operator bug verified against the assertion", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({ system: "s", prompt: debugPromptWith({}) });
    const out = JSON.parse(res.text) as DebugOutput;
    expect(out.fixable).toBe(true);
    expect(out.fixedLine).toBe("  return a + b;");
    expect(out.was).toBe("  return a - b;");
    expect(out.explanation).toContain("changing `-` to `+`");
  });

  it("finds the right operator among several (multiply)", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({
      system: "s",
      prompt: debugPromptWith({ args: [4, 3], expected: 12, actual: 7, bodyLine: "  return a + b;", returnExpr: "a + b" }),
    });
    const out = JSON.parse(res.text) as DebugOutput;
    expect(out.fixable).toBe(true);
    expect(out.fixedLine).toBe("  return a * b;");
  });

  it("declines when no single operator swap fits (honest, not a guess)", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({
      system: "s",
      prompt: debugPromptWith({ args: [2, 3], expected: 100, actual: 5, bodyLine: "  return a + b;", returnExpr: "a + b" }),
    });
    const out = JSON.parse(res.text) as DebugOutput;
    expect(out.fixable).toBe(false);
    expect(out.explanation).toContain("deeper than an operator typo");
  });

  it("declines a non-binary-op body", async () => {
    const p = new ScriptedProvider();
    const res = await p.complete({
      system: "s",
      prompt: debugPromptWith({ returnExpr: "Math.max(a, b)", bodyLine: "  return Math.max(a, b);" }),
    });
    const out = JSON.parse(res.text) as DebugOutput;
    expect(out.fixable).toBe(false);
  });
});

describe("contentHash", () => {
  it("is stable and compact", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).toHaveLength(16);
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
