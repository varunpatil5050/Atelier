# 02 — Tech Stack Decisions (Blueprint §3)

Decision rule used throughout: **spend the novelty budget only on differentiating components**
(relay, warden, indexer, conductor). Everything else must be boring, hireable-for, and operable
by a small team.

---

## 1. Frontend

### 1.1 Next.js 15+ (App Router) — chosen

- **Why:** one framework serves three very different surfaces: marketing (static/ISR),
  dashboard (server components hitting core-api directly, zero client waterfalls), and the IDE
  (a client-rendered island). RSC lets the workspace manifest (file tree head, room token) be
  inlined into the first response — the IDE paints without a fetch waterfall.
- **Tradeoffs:** App Router complexity; server runtime needed (not static-only); RSC mental
  model tax on contributors. The IDE surface deliberately opts out of most Next features —
  it's a `"use client"` subtree with its own lifecycle.
- **Scaling:** stateless Next pods behind the CDN; IDE assets are immutable, hashed,
  CDN-cached; RSC responses cached per-user-role where safe.
- **Rejected:** *Vite SPA* (loses RSC dashboard + unified auth/session story; considered
  seriously — acceptable fallback); *Remix* (fine, smaller ecosystem for RSC-style streaming);
  *Tauri/Electron desktop* (explicit non-goal: browser-first is the differentiator).

### 1.2 React 19 + TypeScript (strict) — chosen

- **Why React:** Monaco, xterm.js, Yjs bindings, and every serious IDE-adjacent library have
  first-class React interop; concurrent features (transitions, `useDeferredValue`) matter for
  keeping typing responsive while heavy panels update.
- **Why strict TS everywhere:** the protocol types (WS frames, protobuf-generated types,
  Zod-validated API payloads) are the contract between four teams' worth of surface area.
  `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **Rejected:** *Solid/Svelte* (better raw perf, but the IDE's hot path bypasses the framework
  anyway — Monaco and xterm render outside React; ecosystem wins).

### 1.3 Tailwind CSS 4 + CSS variables theme layer — chosen

- **Why:** design velocity, dead-code elimination, and a constraint system that keeps a large
  IDE UI visually coherent. Theme tokens (colors, spacing) live in CSS variables so the theme
  system (doc 03 §8) swaps palettes without recompiling; Monaco/xterm themes derive from the
  same tokens.
- **Tradeoffs:** class soup in complex components — mitigated with `cva` variants and a small
  set of primitive components (Radix UI underneath for a11y).
- **Rejected:** CSS Modules (slower iteration), styled-components (runtime cost in an app
  where main-thread budget is sacred).

### 1.4 Monaco Editor — chosen (with eyes open)

- **Why:** VS Code parity is a *user expectation* for a professional cloud IDE: keybindings,
  multi-cursor, find/replace, folding, semantic token rendering, diff editor for agent-diff
  review. LSP integration is well-trodden (`monaco-languageclient`). `y-monaco` gives CRDT
  binding.
- **Tradeoffs vs CodeMirror 6:** Monaco is ~5× heavier (≈3 MB gz), not modular, harder to run
  in a worker, weaker mobile story. CM6 is the better *engineering* substrate; Monaco is the
  better *product* substrate for a VS-Code-shaped IDE. Mitigations: lazy-load Monaco after
  shell paint, aggressive chunk splitting, editor pool reuse across tabs.
- **Escape hatch:** the editor is wrapped behind an internal `EditorHost` interface (doc 03
  §4) so CM6 could replace it for embedded/read-only/mobile surfaces without touching collab.

### 1.5 State: Zustand + Jotai + TanStack Query — chosen (three tools, three jobs)

- **Zustand** — coarse app/IDE shell state (layout, open panes, active workspace, connection
  status). Why: transient updates outside React render, tiny, devtools, no provider tree.
- **Jotai** — fine-grained derived state near the editor (per-file dirty flags, per-pane
  cursor info, agent-presence atoms). Why: atom granularity prevents "one store update
  re-renders the world" in a UI with hundreds of live-updating leaves.
- **TanStack Query** — server state (workspaces list, repo metadata, agent task lists) with
  normalized caching, mutation optimism, and WS-driven invalidation.
- **Explicit rule:** CRDT state is **not** mirrored into any store. Yjs is the store; React
  subscribes via `useSyncExternalStore` adapters. Duplicating it is the classic bug factory.
- **Rejected:** Redux Toolkit (ceremony without benefit here), MobX (implicit reactivity fights
  Yjs's explicit transaction model).

### 1.6 Transport: WebSocket primary; WebRTC rejected for core sync

- **Why WS:** single ordered, reliable, server-mediated channel fits CRDT sync + terminal
  streams + presence; server mediation is *required* anyway for persistence, auth, agents as
  peers, and replay capture. Binary frames, one socket per workspace, multiplexed channels
  (doc 15 §6 defines the frame format).
- **Why not WebRTC for sync:** P2P mesh breaks at >4 peers, TURN relays reintroduce a server
  hop with worse operability, and server-side event capture (replay!) would require an SFU
  anyway. **Kept for later:** optional WebRTC data channel for sub-50ms cursor ghosting on
  LAN-adjacent peers, and voice/video huddles (SFU: LiveKit) in the Scale phase.

### 1.7 CRDT framework: Yjs — chosen

Full analysis in doc 04 §2 (Yjs vs Automerge vs OT). Summary: Yjs wins on ecosystem
(`y-monaco`, `y-protocols` awareness), update-encoding compactness, GC of tombstones, and
proven 100+-peer deployments. Automerge's Rust core and patch semantics are attractive; its
memory profile and binding maturity for Monaco are not.

---

## 2. Backend languages — Go vs Rust vs Node analysis

| Criterion | Go | Rust | Node/TS |
|---|---|---|---|
| Concurrency model for 10k WS conns/node | goroutines: ideal | async: ideal but harder | event loop: fine until CPU-bound framing |
| GC pauses on hot broadcast path | sub-ms, acceptable | none | GC + JIT variance |
| tree-sitter / native parsing | cgo friction | native, first-class | N-API friction |
| LLM SDK / AI ecosystem velocity | ok | weak | best-in-class |
| Team hireability / iteration speed | high | medium | high |
| Memory per idle connection | ~4–10 KB | ~1–4 KB | ~10–30 KB |

**Decision — polyglot by plane, one language per service:**

- **Go** → `core-api`, `collab-relay`, `room-router`, `workspace-orchestrator`, `warden`.
  Rationale: these are network servers whose complexity is concurrency and protocol handling —
  Go's exact sweet spot. The warden lives on execution nodes and must be a single static
  binary with tiny footprint.
- **Rust** → `indexer` (+ the graph query service). Rationale: tree-sitter is a C library with
  first-class Rust bindings; parsing thousands of files/sec, building compact interned symbol
  tables, and memory-mapping graph artifacts is Rust's exact sweet spot. Also the strongest
  resume signal per line of code.
- **TypeScript (Node 22)** → `conductor`, `model-gateway`, `intelligence-api` orchestration
  layer. Rationale: fastest-moving AI SDK ecosystem, shared types with the frontend for agent
  trace rendering, and these services are I/O-bound coordinators, not CPU-bound.

**Rejected:** single-language purity. All-Go: pain in AI layer + tree-sitter. All-Rust:
iteration tax on CRUD. All-Node: relay and warden would be the wrong tool.

### 2.1 gRPC (+ Connect) — chosen for interservice; JSON at the edge

- **Why:** protobuf contracts are the *only* way a 10-service polyglot system stays coherent —
  codegen for Go/Rust/TS from one `proto/` tree (managed with `buf`, breaking-change CI).
  Streaming RPCs fit warden↔orchestrator (exec streams) naturally. Connect gives
  gRPC-compatible handlers that also speak JSON/HTTP for debuggability.
- **Tradeoffs:** binary opacity (mitigated by Connect JSON + grpcui in dev), proto ceremony.
- **Rejected:** REST-everywhere (no streaming, no contracts), GraphQL interservice (wrong
  layer; fine at the edge later for dashboard aggregation, not adopted at MVP).

### 2.2 Postgres 16 — chosen as system of record

- **Why:** relational integrity for tenancy/authz data, LISTEN/NOTIFY for cheap dev-mode
  events, `pgvector` to defer a vector DB, RLS for tenant isolation defense-in-depth, and the
  deepest operational literature of any store. Aurora-compatible for managed scaling.
- **Scaling:** read replicas → per-plane logical DBs (`core`, `intel`, `timeline`) → org-id
  sharding only if a single-writer ceiling is actually hit (doc 11 §3). Partitioning for
  event-shaped tables from day one (doc 08 §4).
- **Rejected:** CockroachDB (ops + latency tax before it's needed), DynamoDB (access patterns
  too relational), MySQL (no pgvector/RLS equivalents in one box).

### 2.3 Redis 7 — chosen (cache + presence directory + rate limiting)

Roles: room→relay directory (with TTL heartbeats), presence summaries, session token
revocation set, sliding-window rate limits, hot retrieval cache. **Explicitly not** a message
bus (that's NATS) and not a source of truth. Rejected: Memcached (no data structures),
Dragonfly (attractive perf, less battle-tested — revisit at scale).

### 2.4 NATS JetStream — chosen over Kafka

- **Why NATS:** subject-based addressing matches per-session/per-repo/per-task fanout
  (`session.{id}.>`) without partition gymnastics; millions of subjects are free; per-subject
  work queues, interest-based retention, exactly-once-ish dedup windows; single small binary —
  the whole platform runs on a laptop. Kafka's strengths (massive ordered partitions,
  long-term storage, stream processing ecosystem) are not this system's shape — our long-term
  storage is S3 segments, our analytics offload is ClickHouse.
- **Tradeoffs:** smaller ecosystem, fewer managed offerings (Synadia exists), no KSQL-style
  processing (we don't need it). Throughput ceiling per stream is real but far beyond our
  needs (doc 11 has the math).
- **Rejected:** Kafka (operational weight, partition-count explosion for per-session subjects),
  Redpanda (better Kafka, same shape mismatch), RabbitMQ (weak replay/retention semantics),
  Redis Streams (no interest-based retention, weaker durability story).

### 2.5 Graph storage: per-repo SCIP-style artifacts + in-memory graph service — chosen over a graph DB

- **Why:** the code graph is **read-heavy, repo-partitioned, and rebuilt incrementally** — the
  worst possible fit for a shared mutable graph database and the best possible fit for
  Sourcegraph's proven approach: the indexer emits compact immutable graph artifacts
  (interned strings, delta-encoded edge lists, memory-mappable) per repo version to S3; a
  stateless Rust `graph-query` service mmaps hot repos with LRU eviction and serves
  defs/refs/callers/callees/paths over gRPC. Queries are 1–3 hop traversals — microseconds
  in-memory, no Cypher needed.
- **Rejected:** Neo4j (JVM ops burden, licensing, global-graph model fights per-repo
  versioning), Memgraph (better, same shape mismatch), Postgres recursive CTEs (fine for MVP —
  and is in fact the Phase-1 implementation — but ref-lookup latency degrades on monorepos).

### 2.6 Vector storage: pgvector → Qdrant migration path — chosen

- **Phase 1–2 (≤ ~5M vectors):** `pgvector` with HNSW. Why: zero new infra, transactional
  consistency with chunk metadata, filtered search via SQL WHERE.
- **Phase 3+:** **Qdrant** — Rust, first-class payload filtering (`repo_id`, `lang`, `path
  prefix`), scalar/binary quantization, collection-per-shard multi-tenancy. Migration is
  mechanical because all access goes through the `intelligence-api` retrieval interface.
- **Rejected:** Pinecone (cost + data egress at scale, closed), Weaviate (heavier, Java-ish
  ops), Milvus (powerful but operationally large), OpenSearch kNN (kept as the *lexical*
  engine only if Tantivy is dropped).

---

## 3. AI layer

| Concern | Choice | Why / rejected |
|---|---|---|
| Orchestration | **Custom event-sourced "conductor"** (TS) on NATS | Determinism, replay, and cross-language event integration are core product features; LangGraph rejected as runtime (analysis in doc 07 §8) but its checkpoint/graph ideas are borrowed |
| Models | Claude family via **model-gateway** | Frontier coding capability; gateway abstracts provider, enforces budgets, adds caching + fallback (e.g., Haiku-class for summarization/reranking, Opus/Fable-class for planning/coding) |
| Embeddings | Code-specific embedding model behind gateway (e.g., Voyage-code class), batch API | Swappable; batched via queue; dimensions fixed at 1024 with Matryoshka truncation to 256 for cheap prefiltering |
| Memory | Layered: task scratchpad (event log) · repo memory (hierarchical summaries) · org memory (facts store) | Doc 07 §6; no framework — memory is rows + artifacts with explicit provenance |
| Context management | **Context compiler** with priority tiers + token ledger | Doc 07 §7; deterministic, cache-aligned prompt assembly |
| Evals | Golden-task suite + trace-replay regression harness | Doc 13 §6; agent changes gate on eval pass rates like code gates on tests |

---

## 4. Infrastructure

| Layer | Choice | Rationale (condensed) | Rejected |
|---|---|---|---|
| Orchestration | **EKS** (control/collab/intel planes) | Managed control plane, Karpenter autoscaling, boring | Self-managed k8s (ops), ECS (weaker ecosystem), Nomad (smaller talent pool) |
| Execution plane | **Bare-metal EC2 (`.metal`) + custom warden**, *not* K8s-scheduled | Firecracker needs KVM; per-VM scheduling decisions (bin-packing by memory + warm pools) are domain-specific; K8s pod model fights microVM lifecycle. gVisor-on-K8s is the Phase-1 stepping stone (doc 05 §2) | Kata on K8s (viable alternative, more moving parts), Fargate (no nested virt) |
| Containers | Docker/BuildKit for images; **containerd** on nodes; workspace rootfs via eStargz lazy-pull | Standard, fast cold starts | Podman (no advantage here) |
| IaC | **Terraform + Terragrunt** (envs: dev/staging/prod), modules per plane | Industry default, reviewable plans | Pulumi (fine; TF chosen for reviewer familiarity), CDK (AWS-lock) |
| CI/CD | **GitHub Actions** + Turborepo remote cache; Argo CD for GitOps deploys | PR-native; GitOps gives audit + rollback | Jenkins (no), Buildkite (nice, later) |
| Service mesh | **Linkerd** (mTLS, retries, golden metrics) control plane only; execution plane uses plain mTLS via SPIRE | Lightweight Rust proxies, near-zero config vs Istio's complexity tax | Istio (power we don't need), Cilium mesh (kept as CNI + NetworkPolicy layer instead) |
| CNI / netpol | **Cilium** (eBPF NetworkPolicy, Hubble flow logs) | Default-deny east-west with observability | Calico (fine, fewer flow tools) |
| Ingress | **Envoy Gateway** (HTTP + WS-aware LB with least-conn + drain), wildcard `*.preview.*` via dedicated preview-router | WS session affinity + graceful drain are first-class needs | NGINX ingress (weaker drain semantics), ALB-only (no custom routing logic) |
| Observability | **OTel SDKs everywhere → OTel Collector → Prometheus (Mimir at scale) + Loki + Tempo + Grafana** | One pipeline, three signals, exemplars link metrics→traces; Tempo over Jaeger for object-storage-backed scale (Jaeger UI compatibility retained) | Datadog (cost at WS/event volume; fine as day-1 shortcut), ELK (heavy) |
| Secrets | External Secrets Operator + AWS Secrets Manager; SPIRE for workload identity | No secrets in env-committed files ever | Vault self-hosted (ops burden until Scale phase) |
