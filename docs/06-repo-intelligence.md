# 06 — Repository Intelligence Engine (Blueprint §7)

One service surface (`intelligence-api`, gRPC) backed by three stores — **code graph**
(structure), **vector index** (semantics), **lexical index** (exact-ish text) — kept fresh by
an incremental **indexer** (Rust). Consumers: the IDE (search, peek, graph viewer), the agents
(retrieval, impact analysis), and the Reviewer pipeline (blast radius).

Supported languages at launch: **TypeScript, JavaScript, Python, Go** — chosen because their
tree-sitter grammars are excellent and their resolution semantics span the difficulty range
(Go: easy; TS: moderate with tooling; Python: dynamic and humbling).

---

## 1. Pipeline overview

```
                     ┌──────────────── full pass (clone/push) ───────────────┐
repo.changed event → │ Merkle diff → dirty file set                          │
                     └───────────────────────────────────────────────────────┘
   for each dirty file:
   tree-sitter parse (error-tolerant)
     ├─→ symbol extraction (defs, refs, imports, exports) ──→ graph patch
     ├─→ AST-aware chunker ──→ changed chunks ──→ embed queue ──→ vector upsert
     └─→ lexical tokenizer ──→ Tantivy segment update
   graph patch + resolver pass (cross-file) → new graph artifact version
   → publish repo.indexed {repoId, version, stats}
```

**Incrementality is the whole game.** A Merkle tree over `(path, blobHash)` makes "index the
repo" and "re-index after one keystroke burst" the same algorithm with different dirty-set
sizes. Live-edit reindexing is debounced 2 s after CRDT save-to-disk; git pushes to the mirror
trigger immediately. Target: single-file change → fresh graph+vectors in < 3 s p95.

## 2. Parsing & symbol extraction (tree-sitter)

- **Why tree-sitter:** incremental, error-tolerant (parses code *mid-edit*), one C API for all
  grammars, `.scm` query files per language keep extraction declarative, and it's what
  GitHub/Zed/Neovim bet on. Rust bindings are first-class → the indexer is Rust.
- Per language, query packs extract: definitions (functions, classes/types, methods, consts),
  references (identifiers with enclosing scope), imports/exports, and doc comments.
- **Limits acknowledged:** tree-sitter gives syntax, not semantics — no type info, no import
  resolution. That's the resolver's job (§3). We deliberately do **not** run full compilers in
  the hot path; precision is layered (§4).

## 3. Code graph construction

**Schema (property graph, but stored as artifacts — see §5):**

```
Nodes: Repo, File, Module, Symbol{kind: fn|class|method|type|var, fqname, sig, span}
Edges: CONTAINS(file→symbol), IMPORTS(file→file|module),
       DEFINES(module→symbol), REFERENCES(symbol→symbol, kind: call|read|write|extend|impl),
       EXPORTS(module→symbol), DEPENDS_ON(pkg-level, from manifest parsing)
```

**Resolver (per-language strategies, common interface):**

| Lang | Import resolution | Reference→definition binding |
|---|---|---|
| Go | trivial (package paths, `go.mod`) | high precision from syntax + package scan alone |
| TS/JS | tsconfig paths, package.json exports, node resolution algorithm reimplemented | Tier-1 heuristic (scope + import maps); Tier-2 optional `tsserver` sidecar batch pass for call-graph precision on demand |
| Python | sys.path model, `pyproject`, namespace pkgs | Tier-1 scope analysis; dynamic dispatch marked `confidence: low` rather than guessed |

Every edge carries a **confidence** (`exact | inferred | heuristic`) — consumers (agents!)
must know whether "callers of X" is proof or hint. This honesty is unusual and valuable: the
Reviewer agent treats `heuristic` blast-radius edges as "verify with tests", not facts.

## 4. Graph storage: versioned artifacts, not a graph database

(Decision rationale in doc 02 §2.5.) The indexer emits, per repo version, an immutable
**graph artifact**: string-interned symbol table + CSR-encoded edge lists + span index,
serialized (rkyv/flatbuffers-style) so the `graph-query` service can **mmap and traverse
without deserialization**. Artifacts → S3, hot ones cached on local NVMe, LRU in memory.

- Queries served over gRPC: `defs(file)`, `refs(symbol)`, `callers/callees(symbol, depth)`,
  `importsClosure(file)`, `blastRadius(diff) → affected symbols/files/tests`,
  `pathBetween(a,b)`. All are 1–3 hop traversals: µs–ms in-memory.
- Versioning for free: agents pin a graph version for a whole task run (consistent reasoning
  even while humans keep editing); the IDE always reads latest.
- **Phase-1 shortcut:** same logical schema in Postgres tables + recursive CTEs. The gRPC
  interface is identical, so swapping the backend is invisible to consumers.

## 5. Chunking & embedding pipeline

- **AST-aware chunking:** chunk = smallest of (function/method, class-with-elided-bodies,
  contiguous top-level span) fitted to 150–400 tokens. Each chunk is embedded with a
  **context header**: `repo-relative path · language · enclosing scope chain · imports used
  in chunk · docstring` — headers massively improve retrieval for "where do we validate JWTs"
  queries because the raw body may never say "JWT".
- Oversized functions: split at statement boundaries with 1-line overlap + shared header.
  Non-code (md, yaml, proto): paragraph/stanza chunkers.
- **Embedding worker (TS service):** consumes `embed.jobs` queue, batches 64–128 chunks/call
  through model-gateway, upserts `{vector, repoId, path, spanBytes, symbolIds[], contentHash,
  graphVersion}`. Content-hash dedup means renames/moves don't re-embed.
- Vector store: pgvector→Qdrant path per doc 02 §2.6, HNSW, payload-filtered by repo/lang/path.

## 6. Hybrid retrieval (the query side)

```
query ─┬─ lexical: Tantivy BM25 (code tokenizer: camelCase/snake_case splitting,
       │            identifier boosting) ................................ top 50
       ├─ vector: query embed → ANN, filter {repo, lang?, pathPrefix?} .. top 50
       └─ symbol: exact/fuzzy symbol-name match via graph symbol table .. top 20
  → Reciprocal Rank Fusion (k=60) → candidate pool ~80
  → graph expansion: for top candidates, pull 1-hop neighbors
      (callers, callees, same-module siblings, tests referencing them) — bounded +30
  → rerank: cross-encoder scoring (fast path) or Haiku-class LLM listwise rerank
      for agent queries where quality > 100 ms
  → return spans with anchors {path, byteRange, graphVersion, why[]} 
```

- **`why[]`** — each result explains its provenance ("lexical match on `verifyToken`",
  "called by `AuthMiddleware` which matched") — surfaces in the IDE and, crucially, in agent
  context so the model knows *why* it's seeing a snippet.
- Rejected: embeddings-only retrieval (fails exact-identifier queries), lexical-only (fails
  conceptual queries). Hybrid + graph expansion is the difference between demo and product.

## 7. Repo memory & summarization

Hierarchical summaries, generated bottom-up and cached with drift invalidation:

- **L0:** per-file capsule (generated for files > 200 LOC): purpose, key exports, gotchas.
- **L1:** per-module/directory summary composed from L0s + graph stats (fan-in/fan-out).
- **L2:** repo overview: architecture narrative, entry points, layering, conventions
  (test framework, error patterns, DI style) — the "onboarding doc" no one wrote.
- Invalidation: summary stores the Merkle hash of its subtree; drift > threshold → re-queue.
  Generation uses cheap-model map + strong-model reduce; costs are bounded and one-time-ish.
- Also mined into a **facts store** (typed rows: `{fact, evidence spans, confidence}`):
  "HTTP layer is Fastify", "uses pnpm workspaces", "DB access only via `packages/db`". Agents
  consume facts as cheap, high-precision context; humans see them on the repo dashboard.

## 8. Cross-file reasoning support (what agents actually call)

- `contextPack(taskGoal, seeds[], tokenBudget)` — the flagship RPC: takes seed spans/symbols +
  a budget, walks the graph outward by relevance-weighted BFS (edge-type weights: callers >
  callees > siblings > tests), fills the budget with chunks + facts + L1/L2 summaries, returns
  a deterministic, citation-annotated context bundle. This is the context compiler's (doc 07
  §7) retrieval backend.
- `blastRadius(diff)` — parse hunks → touched symbols → transitive dependents (bounded depth,
  confidence-weighted) → affected files + the test files that reference them. Powers the
  Reviewer agent, the CI test selector, and the IDE's "this change affects 14 call sites" pill.

## 9. Operational shape

- Indexer workers are stateless consumers on `repo.jobs` (JetStream work queue) — horizontal
  scaling is consumer count; per-repo ordering via subject partitioning `repo.jobs.{repoId}`.
- Full index of a 1M-LOC TS monorepo: target < 4 min parse+graph, < 15 min embeddings
  (batched), on 4 workers. Re-index single file: < 3 s p95 end-to-end.
- Every artifact (graph version, chunk set, summaries) is content-addressed and immutable —
  rollback = pointer flip, A/B of chunker changes = parallel artifact lineages, and eval
  suites (doc 13 §6) pin exact index versions for reproducibility.
