# 11 — Scaling Strategy & Performance Engineering (Blueprint §13–14)

---

## Part A — Scaling by stage

Concurrency model used below: ~10% of registered users concurrent at peak; 1 workspace per
concurrent user; agents add ~0.3 sandbox VMs per active workspace.

### Stage 1 — 10 users (dogfood)
Everything on one small EKS cluster + 2 metal nodes (or gVisor-only, no metal). Single
Postgres, single-node NATS, pgvector, Postgres-CTE graph. **Deliberately zero premature
scaling work** — but the *shapes* (planes, events, contracts) are already final, which is the
whole point of this architecture: scaling is replacement-of-parts, not redesign.

### Stage 2 — 1,000 users (~100 concurrent)
- 2–3 relays (10k conns each is comfortable; we're at ~100 — redundancy, not capacity).
- 3-node NATS cluster (R3 streams). Postgres: single writer + 1 replica. 3–5 metal nodes.
- First real bottleneck class: **cold starts under morning spike** → warm pools + predictive
  prewarm (doc 05 §6). Second: embedding backfill bursts on big repo imports → queue with
  per-org fairness (weighted round-robin consumers).

### Stage 3 — 100,000 users (~10k concurrent)
- **Collab:** ~15–25 relays; router directory in Redis cluster; room placement by capacity
  score. WS ingress via NLB with connection draining; relays are the unit of blast radius —
  one relay death = ~500 rooms reconnect in <5 s, invisible platform-wide.
- **Execution:** 100–200 metal nodes; orchestrator becomes the scheduling hot spot →
  shard orchestrators by node-pool; bin-packing with hibernation-aware overcommit (~3:1
  memory overcommit given snapshot economics).
- **Data:** Postgres → logical split (`core`/`intel`/`timeline` become separate clusters) +
  read replicas; `ai_traces`/`executions` analytics move to **ClickHouse** (fed by SYS/NATS →
  vector-agent sink); vector search → **Qdrant cluster** (collection per shard-group,
  replicated), retrieval API unchanged.
- **Intelligence:** indexer worker pool autoscaled on queue depth; graph-query nodes with
  NVMe artifact cache + consistent-hash artifact affinity.
- **Conductor/model-gateway:** scale on step-queue depth; provider rate-limit pooling across
  keys; regional provider failover.

### Stage 4 — 1,000,000 users (~100k concurrent)
- **Multi-region active-active for the session planes** (collab + execution follow the
  user; room and workspace are region-pinned = no cross-region CRDT merging on hot paths),
  control plane primary-region with regional read caches, async cross-region replication.
  Region residency doubles as an enterprise feature.
- Org-id sharding for `core` Postgres if writer ceiling approached (mechanical: all keys
  already org-prefixed); JetStream → per-region clusters with mirrored SYS streams.
- CDN strategy: assets globally; RSC/dashboard edge-cached per region; preview domains on
  regional wildcard certs with GeoDNS.
- **Edge synchronization experiment (Scale-phase R&D):** relay-lite at PoPs for cursor/
  awareness fanout (sub-50 ms presence globally) while CRDT truth stays region-pinned.

### Scaling invariants (what makes all of this tractable)
1. Rooms single-homed; workspaces single-noded → no distributed consensus on hot paths.
2. All fan-out flows through NATS subjects → adding consumers never touches producers.
3. All heavy compute (indexing, embedding, agent steps, exec jobs) is queue-shaped →
   autoscaling = consumer count on lag.
4. All big data is immutable S3 artifacts addressed by content/version → caching is trivial.

---

## Part B — Performance engineering

### 1. Performance budgets (enforced, not aspirational)

| Path | Budget | Enforcement |
|---|---|---|
| Keystroke → local echo | ≤ 8 ms (never blocks on React) | perf test in CI (Playwright + CDP tracing) |
| Keystroke → remote peer echo p95 | ≤ 120 ms same-region | RUM SLI + synthetic canary |
| IDE shell first paint (repeat visit) | ≤ 1.0 s | Lighthouse CI budget |
| IDE interactive (editor accepts input) | ≤ 2.5 s warm | Playwright timing in CI |
| JS main bundle (pre-Monaco) | ≤ 300 KB gz | size-limit in CI, PR-blocking |
| Terminal output → paint p95 | ≤ 50 ms | synthetic probe |
| Retrieval p95 / agent contextPack p95 | ≤ 800 ms / ≤ 2 s | service SLO |
| Replay seek (any point in 8h session) | ≤ 1.5 s | snapshot cadence math (doc 12 §4) |

### 2. Frontend

Covered in doc 03 §10 — the load-bearing items: Yjs→Monaco bypasses React; single batched
decoration pass per frame; virtualization everywhere; Monaco/xterm/grammars lazy-chunked;
workers for highlight/search/replay-decode; editor pooling; service-worker shell precache
(“lazy hydration” = RSC shell paints instantly, IDE island hydrates progressively,
panels hydrate on first reveal).

### 3. Network & protocol

- Adaptive batching: WS flush interval scales with measured RTT (30 ms floor) — never batch
  below human-perceptible timescales just to save frames.
- Delta everything: Yjs updates are deltas by nature; awareness is delta-encoded; pty frames
  coalesce at 8–16 ms; permessage-deflate **off** (CPU on relay at fanout scale; zstd at
  the persistence boundary instead), revisit for low-bandwidth clients.
- Regional WS termination even before full multi-region: TLS+WS terminate at regional edge,
  backhaul over persistent HTTP/2 to home-region relay — cuts handshake RTTs for far users.

### 4. Backend hot paths

- Relay: zero-alloc frame path (pooled buffers, `io_uring`-style batched writes where
  available), per-room goroutine keeps cache locality, fanout writes vectored.
- Graph-query: mmap + interning means a "callers of X depth 2" is pointer-chasing over
  packed arrays — measured target < 1 ms p99 on hot repos.
- Postgres: prepared statements, `pgbouncer` transaction pooling, hot-path queries covered
  by indexes with quarterly reaping (doc 08 §4).

### 5. AI-path performance & caching

- **Prompt-cache alignment** (doc 07 §7): stable T0/T1 prefixes → provider cache hits on
  multi-step runs; measured as a first-class metric.
- **Inference caching:** model-gateway caches `(promptHash, params)` → response for
  deterministic-temperature calls (summaries, rerank) with TTL + version bust; retrieval
  cache keyed `(queryHash, graphVersion)` is immutable-safe.
- **Embedding throughput:** batch API, 128/call, dedup by content-hash (~40% of saves are
  no-ops after formatting-only changes — hash on normalized AST tokens, not bytes).
- **Speculative context prefetch:** when a user opens an agent composer scoped to a
  directory, contextPack warms in the background — perceived agent start latency drops ~1 s.

### 6. Replay & storage compression

Timeline segments: protobuf frames → zstd dictionary-trained per channel type (pty output
compresses ~12:1; CRDT updates ~4:1 after Yjs's own encoding). Snapshot cadence balances
seek latency vs storage (doc 12 §4). S3 lifecycle: segments → IA at 30d → Glacier at 180d
per org retention policy.
