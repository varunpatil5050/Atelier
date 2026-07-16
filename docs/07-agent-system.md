# 07 — Autonomous AI Agent System (Blueprint §8)

**Conductor** is an event-sourced multi-agent orchestration engine. Its central design
commitment: *an agent run is a data structure, not a process.* Every model call, tool call,
decision, and verification result is an immutable event; the "agent" you observe is a fold
over that log. This buys crash recovery, deterministic replay, audit, and observability as
storage properties instead of features.

---

## 1. Execution model

```
TaskRun (id, goal, scope, budget, graphVersion-pin)
  └─ ExecutionGraph: DAG of Steps (created dynamically by the Planner, mutable via events)
       Step = { id, agentRole, dependsOn[], state: pending|running|blocked|done|failed,
                attempts[], budgetSlice }
       Attempt = ordered events:
         step.attempt.started {contextManifest}
         model.call {promptHash, modelId, params, cacheKeys}   ── recorded verbatim
         model.result {output, usage, stopReason}
         tool.call {toolId, argsHash, args}                    ── recorded verbatim
         tool.result {resultHash, result | artifactRef}
         step.verification {gates[], outcomes[]}
         step.attempt.finished {status, confidence}
```

- Conductor workers are **stateless**: they claim a runnable step (JetStream work queue,
  per-run ordering), fold its events to reconstruct state, execute one attempt, emit events.
  Worker dies mid-step → attempt marked stale by heartbeat timeout → re-claimed; side effects
  are idempotent (tool calls carry `(runId, stepId, attempt, seq)` idempotency keys).
- **Determinism boundary:** the *only* nondeterministic operations are model calls and tool
  effects — both recorded with full inputs/outputs. Replay mode substitutes recorded results
  for live calls → a run re-simulates byte-identically (doc 12 §5). This also powers
  regression testing: change a prompt template, replay 200 recorded runs, diff the divergence
  point.

## 2. Agent roster

| Agent | Model tier | Contract (input → output) | Notes |
|---|---|---|---|
| **Planner** | strongest | goal + contextPack → ExecutionGraph patch: steps w/ acceptance criteria, file-scope predictions, risk class | Re-invoked on plan failure (replanning is a graph patch, keeping history) |
| **Coder** | strong | step spec + contextPack → structured patches | Edits via `propose_patch` tool (per-hunk, anchored to graphVersion spans) — never raw file overwrites; patches apply as CRDT transactions with agent origin → visible presence, per-hunk attribution |
| **Tester** | strong | diff + blastRadius → new/updated tests + sandbox run results | Owns "prove it": selects affected tests via graph, writes missing ones, runs in sandbox |
| **Debugger** | strongest | failing signal → hypothesis loop | Explicit hypothesis ledger: propose → design probe (log injection, test, breakpoint script) → run → confirm/refute → next. The ledger renders as the debugging timeline (doc 03 §5.6) |
| **Reviewer** | strong | final diff + criteria → rubric findings {severity, span, rationale} | Runs static analysis + graph blast-radius + style/consistency vs repo facts; findings can spawn fix-steps or escalate to human |
| **Summarizer** | cheap | anything → compressed artifacts | Context compression, step summaries, PR descriptions |

Multi-agent coordination is **blackboard-style**: agents don't message each other directly;
they read/write the shared TaskRun state (events + artifacts). "Planner tells Coder" =
Planner emits steps; Coder workers pick them up. This kills the distributed-conversation
failure mode where agents chat past each other.

## 3. Tools (the capability surface)

Tools are declared in a registry with JSON-schema args, capability requirements, cost class,
and idempotency class:

```
read_file, search(hybrid retrieval), graph_query(callers/refs/blast),
propose_patch, run_command(sandbox), run_tests(sandbox, structured results),
read_terminal(recent workspace output), git(branch/commit/diff on agent branch),
ask_human(question, options) — a first-class tool: emits approval event, parks the step
```

- **Sandboxing:** every `run_command`/`run_tests` executes in the task's **agent sandbox** —
  a dedicated microVM cloned from the workspace volume snapshot at task start (doc 05), with
  registry-only egress. Agents never execute in the user's live workspace VM; they *propose*
  CRDT edits into the live doc space (which humans see and can interrupt) but *run* against
  their sandbox clone. This split is the safety cornerstone.
- **Rollback:** agent work lands on an agent git branch in the sandbox; the CRDT-proposed
  hunks are tracked per-step, so "revert step 4" = inverse patch application; whole-task
  abort = discard branch + inverse-apply unaccepted hunks. Timeline retains everything.

## 4. Verification pipeline & confidence

Every Coder/Debugger step passes gates before its output is marked done:

```
G1 syntax: tree-sitter parse of touched files (free, instant)
G2 static: typecheck + linter for touched packages (sandbox, cached toolchains)
G3 tests: blastRadius-selected tests + Tester-authored tests
G4 review: Reviewer rubric — blocking findings fail the gate
G5 policy: risk classifier (touched paths vs protected globs: auth/, payments/, *.tf,
           migration files, CI config → force human approval regardless of confidence)
```

**Confidence score** = calibrated logistic over gate outcomes + self-consistency signals
(model's structured self-eval, retry count, plan-drift measure). Not a vibe — its
calibration is checked against golden-run outcomes in the eval pipeline (doc 13 §6).

**Human approval workflow:** thresholds per org policy — e.g. auto-merge to agent branch at
conf ≥ 0.9 + G1..G4 pass + risk class low; otherwise `agent.approval.requested` → IDE
approval surface (per-hunk accept/reject, doc 03 §5.4) → `granted/rejected/edited` events
resume the graph. Rejections carry structured reasons → fed back as replanning context and
logged for eval mining.

## 5. Self-correction & reflection

- **Attempt loop:** gate failure → failure evidence (compiler output, failing test, reviewer
  finding) is *structured* into the next attempt's context (not just appended text) with an
  explicit "what changed since last attempt" section. Max attempts per step (default 3), then
  escalate: replan (Planner) or ask_human.
- **Reflection checkpoints:** after every N steps or budget fraction, a cheap-model
  reflection pass compares trajectory vs. plan acceptance criteria → emits
  `run.reflection {onTrack, driftNotes, recommendation}`; conductor can trigger replanning.
  This is bounded, structured reflection — not open-ended "think about your feelings" loops
  that burn tokens.
- **Failure taxonomy** recorded on every failed attempt (`context-miss | wrong-plan |
  env-issue | flaky-test | model-error`) — mined weekly to direct engineering effort (bad
  retrieval? brittle sandbox? prompt regression?).

## 6. Memory architecture

| Layer | Store | Lifetime | Contents |
|---|---|---|---|
| Working memory | the event log itself | task run | everything; the fold is the state |
| Task scratchpad | artifact store (S3) + refs in events | task run | large tool outputs, diffs, logs (events store hashes + refs, keeping the log lean) |
| Repo memory | intelligence plane (doc 06 §7) | repo lifetime | summaries, facts — *shared with humans*, provenance-linked |
| Org memory | Postgres facts table | org lifetime | conventions & preferences learned from approvals/rejections ("this org rejects `any`", "prefers table-driven tests") — written only via an explicit distillation job over approval events, never silently |

No vector-DB "agent memories" blob: every remembered fact has provenance (which run, which
evidence) and is inspectable/deletable in the org dashboard. Memory you can't audit is a
liability in this product category.

## 7. Context engineering (the token budget system)

- **Budget ledger per run:** plan budget → per-step slices (planner assigns, conductor
  enforces). Exhaustion → cheapest-first degradation: compress context → drop optional
  retrieval → downgrade model tier for mechanical steps → park + ask_human. Overspend is
  impossible by construction (gateway rejects calls without budget headroom).
- **Context compiler:** deterministic prompt assembly with priority tiers:

```
T0 system + agent role + tool schemas          (stable → provider prompt-cache prefix)
T1 task spec + acceptance criteria + step spec
T2 working set: current diffs, failing evidence, hypothesis ledger
T3 contextPack from intelligence plane (citation-annotated, budget-fitted)
T4 repo facts + L2 summary
T5 history digest: Summarizer-compressed prior steps (map-reduce, structured)
```

  Tiers are filled top-down against the step's token slice; T0 ordering is byte-stable across
  calls to maximize provider prompt-cache hits (measurable 40–70% input-token savings on
  multi-step runs). The compiled manifest (`contextManifest`: exact item list + hashes) is
  recorded on the attempt — you can always answer *"what did the model actually see?"*.
- **Compression:** long histories → structured digests (decisions made, files touched, open
  questions) not prose summaries; large tool outputs → head/tail + error-line extraction with
  full artifact ref.

## 8. LangGraph vs custom orchestration

| Criterion | LangGraph | Custom conductor |
|---|---|---|
| Dev velocity day-1 | wins clearly | slower start |
| Checkpointing | built-in (its best feature) | event sourcing is our native architecture already |
| Determinism/replay guarantees | partial (checkpoint granularity, runtime opacity) | total — the event log *is* the system |
| Polyglot integration (Go relay, Rust indexer, NATS events, timeline) | awkward: Python/JS runtime with its own state model to bridge | native: conductor speaks the same events as everything else |
| Observability | LangSmith-shaped | our OTel + timeline (agents render in the same replay UI as humans — a product feature, not a dashboard) |
| Lock-in surface | graph API + state serialization format | protobuf events we own |

**Decision: custom, with borrowed ideas** (superstep-style graph advancement, checkpoint
mental model). The deciding argument: replayable timelines and agent presence are *product
differentiators* that require agents to be event-native in our format; wrapping a foreign
runtime would mean translating its state into our events forever — the adapter would cost
more than the orchestrator. Conductor's core is deliberately small (~3–4k lines: fold, claim,
gates, budget ledger); the complexity lives in agents' prompts/tools, which LangGraph
wouldn't write for us anyway.

## 9. Observability & cost

- Every attempt = one OTel trace; spans for context compilation (with cache-hit ratio),
  model calls (tokens, latency, cost, stop reason), tool calls, gates. Exemplars link
  Grafana cost/latency panels straight to traces (doc 10 §3).
- Cost controls: per-org monthly budget → per-run caps; model-tier routing table per step
  type; prompt-cache-aware assembly (§7); batch API for all non-interactive work
  (summaries, embeddings, evals) at ~50% cost; nightly cost-per-successful-task report as
  the north-star efficiency metric.
