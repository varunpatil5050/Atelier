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
    // One provider, two agent tasks — branch on which FACTS block the prompt
    // carries, exactly as a real model would produce different tool outputs
    // for different asks. The caller parses JSON either way.
    if (/^REVIEW_FACTS: /m.test(req.prompt)) {
      const review = composeReview(parseReviewFacts(req.prompt));
      return { text: JSON.stringify(review), provider: this.name };
    }
    const comment = composeDocComment(parseFacts(req.prompt));
    return { text: JSON.stringify({ comment }), provider: this.name };
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

/** The FACTS block the reviewer embeds to score a proposal. */
export interface ReviewFacts {
  symbol: string;
  path: string;
  line: number;
  insertLines: number;
  isDocComment: boolean; // the proposal is a /** … */ block
  namesSymbol: boolean; // the inserted text mentions the target symbol
  callers: number;
  callerFiles: number;
}

export interface ReviewOutput {
  verdict: "approve" | "concerns" | "reject";
  summary: string;
  notes: string[];
}

/** Blast radius above this many callers gets flagged for a closer look. */
const HIGH_BLAST_RADIUS = 3;

function parseReviewFacts(prompt: string): ReviewFacts {
  const match = prompt.match(/^REVIEW_FACTS: (.*)$/m);
  if (!match || !match[1]) {
    throw new Error("scripted provider: review prompt has no REVIEW_FACTS block");
  }
  const facts = JSON.parse(match[1]) as ReviewFacts;
  if (!facts.symbol || !facts.path) {
    throw new Error("scripted provider: REVIEW_FACTS block incomplete");
  }
  return facts;
}

/**
 * Score a proposal from the call graph. The reviewer never auto-rejects — a
 * human still decides; "concerns" is an advisory flag, not a veto. The signal
 * that matters here is blast radius: a doc change touching a widely-called
 * symbol deserves a second look that it stays true across every call site.
 */
function composeReview(f: ReviewFacts): ReviewOutput {
  const notes: string[] = [];
  let verdict: ReviewOutput["verdict"] = "approve";

  const blast =
    f.callers === 0 ? "no callers" : f.callers <= HIGH_BLAST_RADIUS ? "low blast radius" : "high blast radius";
  notes.push(
    `${f.callers} caller${f.callers === 1 ? "" : "s"} across ${f.callerFiles} ` +
      `file${f.callerFiles === 1 ? "" : "s"} — ${blast}.`,
  );

  if (f.callers > HIGH_BLAST_RADIUS) {
    verdict = "concerns";
    notes.push(`Widely used: confirm the doc holds for all ${f.callers} call sites, not just the definition.`);
  }
  if (!f.namesSymbol) {
    verdict = "concerns";
    notes.push(`Inserted text doesn't reference \`${f.symbol}\` — verify it's anchored to the right definition.`);
  }
  if (!f.isDocComment) {
    verdict = "concerns";
    notes.push("Not a documentation comment — this changes code and needs closer review.");
  }

  const summary =
    verdict === "approve"
      ? `Documentation-only insertion above \`${f.symbol}\`; ${blast}. Safe to apply.`
      : `Advisory: ${f.symbol} — ${blast}. Worth a closer look before applying.`;

  return { verdict, summary, notes };
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
