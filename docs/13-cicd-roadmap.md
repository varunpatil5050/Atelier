# 13 — CI/CD, Engineering Workflow & Roadmap (Blueprint §16–17)

---

## Part A — Engineering workflow

### 1. Monorepo: Turborepo (+ Go/Rust integrated via task wrappers)

- One repo: `apps/` (web), `services/` (Go/Rust/TS), `packages/` (shared TS), `proto/`,
  `infra/`, `docs/`. Full tree in doc 15 §1.
- **Turborepo over Nx:** thinner abstraction, remote caching, task-graph is just
  `package.json` scripts — Go (`go build`/`golangci-lint`) and Rust (`cargo`) plug in as
  turbo tasks with hashed inputs, so `turbo run test --filter=...[origin/main]` computes
  affected targets across all three languages. Nx rejected: richer but heavier generator/
  executor machinery we'd fight in a polyglot tree. Bazel rejected: correct answer at 200
  engineers, wrong tax at 2.
- Trunk-based: short-lived branches → PR → squash merge; `main` always deployable;
  release = promoting a built artifact, never rebuilding.

### 2. CI pipelines (GitHub Actions; full YAML in doc 15 §7)

| Pipeline | Trigger | Contents |
|---|---|---|
| `ci.yml` | PR | affected-only: lint (eslint/golangci/clippy), typecheck, unit tests, `buf lint+breaking`, size-limit, build |
| `e2e.yml` | PR label / merge queue | Playwright suites incl. **multiplayer harness** (N browsers, one room, convergence assertions + latency measurements) against ephemeral preview env |
| `agent-eval.yml` | PR touching prompts/conductor/retrieval | golden-task eval suite + injection suite + trace-replay regression (doc §6) |
| `images.yml` | merge to main | BuildKit bake → sign (cosign) → SBOM → push |
| `deploy.yml` | merge / tag | Argo CD app-of-apps sync: staging auto; prod canary |
| `infra.yml` | infra/ PR | terraform plan (comment on PR) → gated apply |
| `load.yml` | nightly | k6: WS soak (10k conns), relay fanout, retrieval QPS; regression gates on p95s |
| `chaos.yml` | weekly staging | scripted drills from doc 10 §5 |

Merge queue (GitHub) keeps `main` green; flaky-test quarantine with auto-issue.

### 3. Environments & deploys

- **Ephemeral preview env per PR** (the product deploys itself to demo itself): namespace-
  scoped stack with shared staging data plane, seeded fixture org, destroyed on merge.
- **Staging:** production-shaped (small metal pool included) — execution-plane changes are
  untestable on kind clusters; this line item is budgeted, not wished for.
- **Prod:** canary by plane — relays: 1 canary node w/ real rooms + SLI compare; conductor:
  5% of runs; core-api: 10% traffic split; warden: one node-pool cohort. Auto-rollback on
  burn-rate alerts (Argo Rollouts analysis).
- DB migrations: expand→migrate→contract discipline, `atlas` lint in CI, never coupled to
  deploys.

### 4. Testing strategy

- **Unit** (per package) and **integration** (testcontainers: PG+NATS+MinIO per service).
- **Contract:** protobuf breaking-change CI + consumer-driven contract tests for the WS
  protocol (recorded frame fixtures shared client/relay).
- **Property-based:** CRDT convergence (random op interleavings across simulated peers →
  assert state equality), saga idempotency (replay any prefix twice), HLC ordering.
- **E2E multiplayer harness** — the crown jewel: Playwright spawns 2–8 browsers into a
  room, drives concurrent edits/terminal use, asserts convergence, measures echo p95,
  kills the relay mid-test and asserts recovery ≤ 5s with no lost acked edits.
- **Load** (k6 + custom Go WS clients), **chaos** (scripted, doc 10 §5).

### 5. AI evaluation testing (gates like tests)

- **Golden tasks:** ~50→300 curated tasks on fixture repos (fix failing test, implement
  endpoint from spec, refactor with behavior preservation, cross-file bug) each with
  machine-checkable success (tests pass, lint clean, diff-size bounds, no protected-path
  writes). Run on every prompt/model/retrieval change; report pass-rate delta + cost delta
  + p50 steps. Statistical honesty: 3 seeds/task, McNemar test before declaring regression.
- **Trace-replay regression:** re-simulate recorded prod runs (recorded tool results, live
  orchestrator) — orchestrator refactors must be no-ops (doc 12 §5).
- **Injection suite:** doc 10 §9 red-team fixtures — any capability violation = hard fail.
- **Retrieval evals:** labeled query→span relevance set per fixture repo; NDCG@10 gate.

---

## Part B — Development roadmap

Solo-or-tiny-team realistic. Each phase names its **exit criteria** (demoable) and its
**biggest risk**.

### Phase 1 — MVP (months 0–3): "multiplayer editor that runs code"
- Web shell + Monaco + Yjs over one relay (rooms, presence, cursors); gVisor workspace
  pods; PTY streaming; file explorer; doc-fs sync; GitHub clone; Postgres/Redis/NATS/S3
  skeleton; outbox; OTel wired from day one.
- Deliberately absent: agents, indexing, replay, Firecracker.
- **Exit:** two browsers pair-program and run tests in a shared cloud workspace, p95 echo
  <150 ms. **Risk:** doc-fs sync edge cases (git checkout during live edits) — timebox to
  the conflict policy in doc 04 §3, not perfection.

### Phase 2 — Alpha (months 3–6): "the platform gets a brain"
- Indexer v1 (tree-sitter symbols, Postgres graph, chunk+embed, hybrid search in IDE);
  conductor v1 (Planner+Coder+Tester, sandbox clones, gates G1–G3, approval UI);
  model-gateway with budgets; session events → S3 segments (capture only); multi-file agent
  diffs as CRDT proposals with presence.
- **Exit:** agent fixes a real failing test in a real repo while a human watches its cursor,
  then approves per-hunk. **Risk:** agent quality perception — mitigate by scoping demo
  tasks to the golden-task classes that eval well.

### Phase 3 — Beta (months 6–10): "production shape"
- Firecracker plane + warden (hibernate/resume!); replay player v1 (scrub, editor+terminal+
  agent channels); Reviewer/Debugger agents + confidence + policy gates; graph artifacts +
  graph-query (replace CTEs); Qdrant migration; preview URLs; RBAC hardening + audit
  export; SLOs + on-call; canary deploys.
- **Exit:** hibernated workspace resumes in <2 s to a live debugger; 30-min session replay
  scrubs smoothly; agent runs are auditable end-to-end. **Risk:** warden/Firecracker
  operational learning curve — de-risk with the §3 staging metal pool early in the phase.

### Phase 4 — Production (months 10–14)
Multi-org tenancy hardening (RLS everywhere, per-tenant KMS), billing/metering, SSO/SAML,
org agent policies, abuse pipeline, SOC2 evidence automation, DR drills, docs site, pricing.
**Exit:** external teams pay. **Risk:** enterprise checklist gravity — timebox by selling
design-partner deals, not certifications.

### Phase 5 — Scale (months 14+)
Multi-region session planes, ClickHouse analytics, plugin API GA, edge presence experiment,
cross-relay mega-rooms if demanded, marketplace-of-agents exploration.

Each phase ships its infra maturity too: MVP = single cluster/terraform-lite; Alpha = staging
env + previews; Beta = canary + on-call; Prod = DR + compliance; Scale = multi-region.
