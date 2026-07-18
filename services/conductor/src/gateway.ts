/**
 * model-gateway (blueprint doc 02 §3, doc 07 §9): the single choke-point
 * through which agents call models. Agents depend only on `ModelProvider`;
 * which provider sits behind it is deployment configuration.
 *
 * Providers:
 *  - ScriptedProvider (here): deterministic, in-process, ZERO network calls
 *    and zero tokens. It "reads" the structured FACTS block agents embed in
 *    their prompts and emits a JSON tool-style response. This exercises the
 *    full agent machinery — prompts, responses, parsing, event recording —
 *    without an API key.
 *  - AnthropicProvider (future): the real model. Deliberately NOT implemented
 *    yet — wiring it is a small isolated step, gated on ANTHROPIC_API_KEY and
 *    an explicit decision to spend tokens. Same interface, same call sites.
 */

import { createHash } from "node:crypto";

export interface CompletionRequest {
  system: string;
  prompt: string;
}

export interface CompletionResponse {
  text: string;
  provider: string;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** Stable hash for recording prompts/outputs in the run log without storing
 * full content inline (doc 07 §1: record hashed inputs at the boundary). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** The FACTS block agents embed in prompts for the scribe task. */
export interface ScribeFacts {
  symbol: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
  callers: number;
  callerFiles: number;
  topCaller?: string;
  preview: string;
}

export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const facts = parseFacts(req.prompt);
    const comment = composeDocComment(facts);
    return {
      // Tool-style structured output, exactly as a real model would be asked
      // to produce — the caller parses JSON either way.
      text: JSON.stringify({ comment }),
      provider: this.name,
    };
  }
}

function parseFacts(prompt: string): ScribeFacts {
  const match = prompt.match(/^FACTS: (.*)$/m);
  if (!match || !match[1]) {
    throw new Error("scripted provider: prompt has no FACTS block");
  }
  const facts = JSON.parse(match[1]) as ScribeFacts;
  if (!facts.symbol || !facts.kind || !facts.path) {
    throw new Error("scripted provider: FACTS block incomplete");
  }
  return facts;
}

function composeDocComment(f: ScribeFacts): string {
  const where = f.container ? `${f.kind} on ${f.container}` : f.kind;
  const usage =
    f.callers === 0
      ? "Not referenced anywhere yet."
      : `Called ${f.callers} ${f.callers === 1 ? "time" : "times"} across ` +
        `${f.callerFiles} ${f.callerFiles === 1 ? "file" : "files"}` +
        (f.topCaller ? ` (e.g. from ${f.topCaller})` : "") +
        ".";
  return [
    "/**",
    ` * ${f.symbol} — ${where}, defined at ${f.path}:${f.line}.`,
    ` * ${usage}`,
    " *",
    " * (documented by scribe · scripted provider — zero tokens)",
    " */",
  ].join("\n");
}
