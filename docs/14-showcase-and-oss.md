# 14 — Showcase & Open Source Strategy (Blueprint §18–19)

---

## Part A — Recruiter/interview wow factors

### 1. Features that make people pause (in demo order)

1. **Hibernate/resume:** close the tab mid-debug → reopen → the debugger is still paused on
   the same breakpoint, REPL state intact, in under 2 seconds. (Firecracker memory
   snapshots — nobody expects this from a personal project.)
2. **Agent with a cursor:** an agent visibly typing in your buffer, interruptible mid-edit,
   while its reasoning streams in the side panel.
3. **Timeline scrubbing:** drag a slider and watch 40 minutes of pairing + agent work replay
   — then **branch a new workspace from minute 23**.
4. **Blast radius:** make an edit, see "affects 14 call sites, 6 tests" light up from the
   live code graph.
5. **Kill -9 a relay during a live multiplayer demo** and keep typing through the <5 s
   failover. Confidence theater backed by real engineering.

### 2. Architecture decisions that read senior-level

- Event sourcing *selectively* (runs/sessions yes, CRUD no) — with the reasoning written down.
- Single-homed rooms instead of distributed CRDT merging — choosing boring correctness and
  documenting the scale-out path you didn't build yet.
- Graph *artifacts* over a graph database; per-language resolver confidence tiers.
- Deterministic agent replay via a recorded nondeterminism boundary.
- The polyglot-by-plane language decision table (Go/Rust/TS each with a defensible "why").
- Failure-mode-first docs: durability windows, poison-message handling, degraded modes.

### 3. Resume bullets (quantify with your real measurements)

- "Built a multiplayer cloud IDE: CRDT collaboration engine (Go + Yjs) sustaining N
  concurrent editors/room at p95 cross-client latency of X ms, with zero-data-loss relay
  failover in <5 s."
- "Designed a Firecracker microVM execution plane with memory-snapshot hibernation — resume
  to a live process state in <2 s; ~3:1 memory overcommit via snapshot economics."
- "Shipped an event-sourced multi-agent system with deterministic replay: every LLM/tool
  call recorded and re-simulable; prompt changes gated by a golden-task eval suite (M tasks,
  seeded, significance-tested)."
- "Built a repository intelligence engine (Rust, tree-sitter): incremental Merkle-diffed
  indexing (<3 s file-to-fresh-index), hybrid lexical+vector+graph retrieval with reranking."
- "Instrumented end-to-end OTel tracing across 3 languages and an event bus — one trace from
  browser keystroke to microVM syscall."

### 4. Best GitHub/demo artifacts

Repo screenshots: the architecture doc set itself (this is rare and screams staff-level);
Grafana board of a live agent run (cost/tokens/spans); the multiplayer e2e harness output;
mermaid diagrams from doc 01. Demos: 90-second video — two cursors + agent cursor → test
fails → agent fixes → per-hunk approve → scrub the timeline → branch from history →
hibernate/resume. Post the relay-kill clip separately; it travels well.

---

## Part B — Open source strategy

### 1. What to open source (and what not)

| Component | License posture | Why it can win stars |
|---|---|---|
| **Relay + WS protocol + client SDK** ("multiplayer rooms for Yjs, batteries included: persistence, snapshots, failover") | Apache-2.0 | Every Yjs adopter needs exactly this and rebuilds it badly; y-websocket is a toy by comparison |
| **Timeline format + player** ("replayable session logs for collaborative apps") | Apache-2.0 | Novel, demo-able, no competitor |
| **Indexer core** (tree-sitter → graph artifacts + AST-aware chunking) | Apache-2.0 | Rides the RAG-for-code wave; useful standalone |
| **warden** (Firecracker workspace agent) | Apache-2.0 or BSL | Niche but high-prestige audience |
| Conductor prompts/agents, billing, org policy, dashboards | Closed (the product) | The moat is the integration, not the parts |

Open-core boundary rule: open source the *infrastructure that others would rebuild*, keep
the *product opinions*.

### 2. Earning contributors & stars (mechanics, not vibes)

- Each OSS repo ships: a 60-second GIF at the top of the README, a `docker compose up`
  quickstart that works first try, an architecture doc (excerpted from this set), 10+
  `good-first-issue`s with maintainer-written repro steps, and a public roadmap.
- Launch cadence: one deep-dive blog post per component (see §3), posted with the repo, not
  before; Show HN when the quickstart is bulletproof; conference CFPs (local meetups →
  StrangeLoop-shaped venues) with the relay-kill live demo.
- Respond to first-time issues within 24h for the first three months — early responsiveness
  is the highest-leverage star multiplier there is.

### 3. Engineering-credibility blog series (each is a chapter of this doc set, with graphs)

1. "Yjs in production: what the demos don't tell you" (batching, backpressure, GC, failover)
2. "We replaced a graph database with mmap'd files" (benchmarks included)
3. "Deterministic replay for LLM agents" (the nondeterminism-boundary trick)
4. "Firecracker snapshots make idle workspaces free" (the economics post — HN catnip)
5. "One trace from keystroke to syscall: OTel across Go, Rust, and TypeScript"
6. "Prompt injection defense as capability design, not prompt design"

### 4. Docs structure for the OSS repos

`README (GIF, quickstart) → docs/concepts (architecture, guarantees, failure modes) →
docs/how-to (persistence backends, auth hooks, scaling) → docs/reference (protocol spec,
config) → docs/internals (annotated source walkthroughs)`. Guarantees-and-failure-modes
pages are the credibility differentiator — most OSS docs only document the happy path.
