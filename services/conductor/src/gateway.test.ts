import { describe, expect, it } from "vitest";
import { ScriptedProvider, contentHash, type ScribeFacts } from "./gateway.js";

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

describe("contentHash", () => {
  it("is stable and compact", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).toHaveLength(16);
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
