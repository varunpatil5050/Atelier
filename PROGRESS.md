# Build Progress

Tracks implementation against [BLUEPRINT.md](BLUEPRINT.md) → doc 13 roadmap.
Build order follows the "first 10 concrete tasks" in docs/15-deliverables.md.

## Phase 1 — MVP ("multiplayer editor that runs code")

| # | Task (docs/15 list) | Status | Notes |
|---|---|---|---|
| 1 | Monorepo scaffold (turbo + pnpm + go.work) | ✅ 2026-07-15 | buf/protobuf deferred: WS protocol uses hand-rolled binary framing + JSON CTRL (migration path documented in protocol/src/ctrl.ts) |
| 2 | Protocol contracts | ✅ 2026-07-15 | Binary frame codec in TS + Go, pinned by shared golden fixtures; 16 TS tests, Go golden/edge tests |
| 3 | collab-relay v0 + web IDE shell | ✅ 2026-07-15 | Go room actors, Yjs update-log relay (see below), awareness w/ disconnect removal, client-driven compaction, slow-client kick; Monaco+y-monaco IDE, presence chips, named remote cursors, latency pill, multi-file Y.Map, reconnect w/ decorrelated jitter |
| 5 | Persistence + kill-the-relay recovery | ✅ 2026-07-15 | FSStore (append log + atomic replace); verified live: relay killed mid-session → offline pill → restart → auto-reconnect → offline edits reconciled, zero loss |
| 4 | Playwright multiplayer harness | ✅ 2026-07-15 | apps/web/e2e: convergence + presence + remote-cursor, late-joiner replay, forced-disconnect offline reconciliation (chaos hook `WsConnection.debugDrop`); runs against prod build; auto-boots relay+web |
| 6 | PTY terminal end-to-end | ✅ 2026-07-15 | services/workspace-host (real shells via creack/pty, hello role=host, reconnect-surviving shells) + relay PTY routing (client↔host, host_status, pty_* lifecycle) + xterm.js TerminalPane. Full-stack Go integration test drives a real /bin/sh through relay routing (tests/integration) |
| — | Containerized execution | ✅ 2026-07-17 | workspace-host gained a Runtime interface (host.go): HostRuntime (dev machine) + DockerRuntime (per-workspace container: docker run -d + pty-wrapped docker exec, -v dir:/workspace, --memory/--cpus/--pids-limit/--network flags; default alpine:3.20, network none). `--runtime docker` flag. Integration test proves containerization (hostname ≠ host, mount visible; skips w/o docker). Live-verified: browser terminal ran inside Alpine container — hostname=container id, kernel=Linux linuxkit, Alpine 3.20, pids cap 256, NET blocked; full sync loop works across the boundary (browser edit → mount → shell; container write → mount → doc-fs → browser file list). First rung down the isolation ladder (host→container→gVisor→Firecracker, blueprint doc 05) |
| 7 | doc-fs sync + git clone | ✅ 2026-07-15 | services/doc-fs (TS): CRDT ⇄ filesystem via @atelier/client (extracted from apps/web — same client for services, agents later); debounced atomic writes, fs.watch with echo suppression, prefix/suffix minimal diffs (cursor-preserving), CRDT-wins reconcile, doc-side deletes propagate (disk-side deletes deliberately don't, v0), binary/1MiB/ignore guards, `--clone` for git URLs; 7/7 integration tests against the real relay; live-verified full loop: browser edit → disk → `node main.ts` in shared terminal → `echo >> main.ts` → editor |
| 8 | core-api + signed room tokens | ✅ 2026-07-16 | pkg/authtoken (compact HMAC, not JWT — no alg negotiation); relay enforces room tokens for participants + service secret for host/doc-fs (RELAY_TOKEN_SECRET/RELAY_SERVICE_SECRET; unset = tokenless dev mode); services/core-api (Go): signed-cookie dev sessions, POST /v1/rooms/{room}/token, GET /v1/workspaces, Store iface with MemStore + Postgres/pgx (docker-compose); web flows session→token with graceful fallback (🔒 signed badge), landing lists recent workspaces. Tests: authtoken unit, relay accept/reject (forged/expired/wrong-room/host-needs-service-secret + token-identity-wins-over-spoofed-hello), core-api handlers, real-Postgres integration. Live-verified: browser signed-in edit works; probe proves no-token/forged hello REJECTED (StatusPolicyViolation) while service secret ACCEPTED; workspace row persisted to PG |
| 9 | OTel metrics + keystroke RUM metric | ✅ 2026-07-17 | pkg/obs (OTel SDK → Prometheus exporter); relay instruments (connections, rooms, frames/bytes by channel, broadcast fan-out, slow-client kicks, compactions); core-api HTTP duration histogram by route/status + POST /v1/rum (session-gated, clamped) ingesting browser-measured WS RTT; web beacons a sample per pong; Prometheus + Grafana in compose with auto-provisioned datasource + "Atelier — Dev Overview" dashboard. Live-verified: two tabs collaborating under auth → dashboard shows connections=2, rooms=1, WS RTT p95≈4.7ms, frames-by-channel, broadcast fan-out |
| 10 | Indexer v0 (tree-sitter → symbols → search) | ✅ 2026-07-17 | services/indexer (Rust): tree-sitter symbol extraction for TS/TSX/JS/Py/Go (functions, methods, classes, interfaces, types, enums — container-aware), in-memory index with ranked fuzzy search (exact>prefix>substring>subsequence + kind/length tiebreaks), notify-based file watching with 300ms-debounced per-file re-index, axum HTTP (/v1/search, /v1/stats, /v1/reindex, /healthz) with localhost CORS; 8 cargo tests (per-language extraction, error-tolerance, ranking, atomic replace). Web: intel.ts client + SymbolSearch sidebar (hidden when indexer absent) → click reveals line in Monaco. Live-verified: searched a workspace (2µs), added a function via CRDT → re-indexed within debounce → found it → clicked → editor jumped to the line. **First intelligence-plane component — Phase 2 begins** |

## Phase 2 — Alpha ("the platform gets a brain")

| Component | Status | Notes |
|---|---|---|
| Indexer v0 (symbols + search) | ✅ 2026-07-17 | see row 10 above |
| Reference/call edges + code graph | ✅ 2026-07-18 | indexer now extracts call sites in one tree walk (enclosing-function stack → `in_symbol`; callee reduced through member/selector/attribute access) for TS/TSX/JS/Py/Go; name-based call graph with honest `heuristic` confidence; `/v1/refs?name=` returns callers + 1-hop blast-radius summary (count + distinct files); IDE find-references flow (click symbol → callers list "N calls across M files" → click caller → editor navigates). 11 cargo tests (+3 ref extraction/aggregation) + clippy clean. Live-verified: `greet` showed 3 callers with enclosing fns, clicked through to a call site, added a 4th caller via CRDT → re-indexed in the debounce → count updated to 4 |
| Embeddings + hybrid retrieval | ✅ 2026-07-18 | AST-aware chunker (one chunk per symbol + context header "path·lang·scope·name"; whole-file fallback); deterministic `HashEmbedder` behind an `Embedder` trait (feature-hashing over camel/snake/acronym-split tokens, L2-normalized — no external calls; model-gateway is the future seam); in-memory vector store (brute-force cosine); RRF hybrid `/v1/retrieve` fusing semantic + lexical with `why[]` provenance; IDE gains a symbols\|content toggle — content mode finds code by what it does, with SEMANTIC/LEXICAL badges. 19 cargo tests (+6: tokenizer, embedding determinism/similarity, chunking, hybrid) + clippy clean. Live-verified: "network connection port" surfaced TcpSocket+connect by their body (not name), excluded unrelated auth code, clicked through to the editor |
| conductor (agents) + model-gateway | ✅ 2026-07-18 | services/conductor (TS): model-gateway (ModelProvider iface + ScriptedProvider — deterministic, **zero external calls / zero tokens**; AnthropicProvider is the future drop-in behind the same iface); event-sourced run log (AgentEvent union → JSONL per run, fold→state); **scribe agent** joins a room via @atelier/client as a purple "scribe (agent)" presence (same protocol as humans), retrieves target via the intelligence plane (search+refs), prompts the gateway, and types a doc-comment into the live CRDT line-by-line (preview-anchored, index-drift tolerant). 12 tests incl. full-stack (real relay + human peer observes agent presence + patch convergence). Live-verified: `--goal "document greet"` → agent documented greet with its real call-graph facts (4 callers, top=welcome); run JSONL = plan→retrieve→generate→apply, 11 events. **Phase 2 (Alpha) COMPLETE (scripted); real model is one isolated wiring step** |

### Increment 2 additions (2026-07-15)

- Go restructured to a single root module (`atelier.dev`); shared frame codec extracted to
  `pkg/wire` (used by relay + workspace-host); relay packages de-nested from `internal/`.
- Terminal v0 limits (documented in host.go): no output ring buffer (late joiners see new
  output only), output dropped while relay connection is down (shells survive reconnects),
  one shared terminal per room on stream 1.

### v0 architecture deltas vs blueprint (deliberate, documented in code)

- **Relay holds no live Y.Doc** — it relays/persists opaque updates; late joiners replay the
  log; boundedness via client-driven compaction (FlagCompact). Correct per CRDT
  commutativity+idempotence; the yrs-backed doc engine replaces it later (doc 04 §4).
- **Rooms never idle-unload** — avoids unload/join races the production router handoff
  solves (room.go package comment).
- **Persistence: FS store, not JetStream+S3** — Store interface is the seam.
- **Indexer: kind-table walk + in-memory index, not .scm packs + graph artifacts** — a
  syntax-tree walker matching node kinds (extract.rs) yields both defs and call edges in one
  pass with less grammar-API surface than `.scm` query packs. Index is per-file symbol +
  reference lists in HashMaps (replace-on-reindex = atomic file updates); the mmap-able CSR
  graph artifacts of doc 06 §4 arrive when the graph grows past calls. Symbols are indexed
  from disk (via doc-fs), so results reflect saved state within the doc-fs + indexer debounce
  (~sub-second end-to-end).
- **Call graph: name-based, `heuristic` confidence** — a reference links to any definition
  sharing its callee name (no scope/type resolution yet), exactly the confidence tiering
  doc 06 §3 prescribes: consumers (and later the Reviewer agent) treat `heuristic` edges as
  hints to verify, not proof. Scope-aware resolution + reverse (defs→refs by span) upgrade
  the tier later. Blast radius is 1-hop (direct callers); transitive arrives with the graph.
- **Embeddings: deterministic HashEmbedder + in-memory brute-force, not a model + pgvector/HNSW**
  — the `Embedder` trait is the seam: a feature-hashing embedder (dependency-free, deterministic,
  testable) stands in for a real code-embedding model behind the model-gateway (doc 02 §3); an
  in-memory brute-force cosine store stands in for pgvector→Qdrant (doc 06 §5/§6). Both are fine
  at workspace scale and swap out behind `retrieve()`/`Embedder`. Because it's token-overlap
  based, it captures content similarity (find code by body), not true synonymy — that arrives
  with a real embedding model.
- **Execution: Docker container, not gVisor/Firecracker** — the Runtime interface is the seam
  (host→docker now; gVisor→Firecracker later, blueprint doc 05 §2). v0 limits: one container
  per workspace-host process, cleaned up on graceful SIGTERM (deferred close → `docker rm -f`);
  a hard kill (SIGKILL / killed parent) orphans it — reap with
  `docker rm -f $(docker ps -q --filter name=atelier-ws-)`. `--network none` by default means
  no egress (so `npm install` needs `--network bridge`); the workspace dir is bind-mounted, so
  doc-fs on the host and the shell in the container see the same files.
- **Auth: dev sessions, not OIDC** — anonymous server-issued identities in a signed cookie;
  the *shape* is production-correct (identity minted+verified server-side, never
  client-asserted), OIDC/SSO slots behind the same `/v1/session` surface. Tokens are compact
  HMAC, not JWT (no alg-negotiation attack surface); one shared secret now, asymmetric keys
  behind the same Mint/Verify interface later. Tokenless dev mode remains the default when
  RELAY_TOKEN_SECRET is unset, so the zero-config quickstart still works.

### Verified evidence (2026-07-15)

- `pnpm --filter @atelier/protocol test` → 16/16 green; `build`/`typecheck` green.
- `go test -race -count=2 ./...` → green (codec goldens, store, WS integration: broadcast,
  late-joiner replay, awareness removal on disconnect, compaction, restart persistence,
  handshake rejection).
- `pnpm --filter @atelier/web build` → green; First Load JS 106 kB (Monaco lazy-chunked).
- Live: two tabs, same room — CRDT sync at 1–3 ms, named remote cursors, presence;
  relay SIGKILL → offline state → restart → reconnect + offline-edit reconciliation +
  disk-restored room (`data/rooms/demo.ylog`).
- Playwright harness (prod build): 3/3 in 11.8 s — convergence (~67 ms cross-client
  propagation), late-joiner replay, forced-disconnect offline reconciliation. The harness
  caught a real seed-after-sync race (subscribe-without-recheck) that manual testing missed.
- Live shared terminal: workspace-host (real zsh) + two browser tabs — commands typed in one
  tab execute and render in both; full-stack Go integration test (`tests/integration`) drives
  /bin/sh through relay routing under -race.

### Verified evidence (2026-07-16, increment 4 — auth)

- `go test -race ./...` green incl. authtoken, relay auth accept/reject, core-api handlers,
  and a real-Postgres integration test (throwaway container; skips if docker/image absent).
- Web + doc-fs typecheck green; doc-fs 7/7 integration still green after provider signature
  change; protocol 16/16.
- Live with enforcement ON (relay w/ RELAY_TOKEN_SECRET+RELAY_SERVICE_SECRET, core-api on
  Postgres, matched room secret): browser shows 🔒 signed + server identity `mossy-vole`,
  edits sync over the token-signed connection; a Go probe against the live relay got
  no-token → REJECTED, forged token → REJECTED (both StatusPolicyViolation in relay logs as
  "room token rejected"), service secret → ACCEPTED; `authtest` workspace row persisted to PG.

## Phase 2 — Alpha ("the platform gets a brain") — not started
### Phase-2 deltas vs blueprint (deliberate)

- **Agents: scripted provider, not a real model** — the `ModelProvider` interface is the seam;
  `ScriptedProvider` reads a structured FACTS block from the agent's prompt and emits a
  deterministic patch, exercising the full machinery (prompts, responses, parsing, event
  recording, CRDT application, presence) with zero tokens. Wiring `AnthropicProvider` behind
  the gateway is a small isolated step gated on ANTHROPIC_API_KEY.
- **conductor v0: single scribe task, not the full agent DAG** — one linear plan→retrieve→
  generate→apply run rather than the Planner/Coder/Tester/Reviewer graph of doc 07; but the
  load-bearing shape is real (event-sourced run log, agents-as-room-participants, retrieval-
  grounded prompts, reviewable CRDT edits). Multi-agent orchestration + human approval gates
  build on this.
- **Agent approval gate** (2026-07-19) — the scribe now proposes by default: it writes a
  Proposal into the room's shared `Y.Map("proposals")` and parks until a human decides in the
  IDE's ProposalPanel (approve/reject), then applies (re-anchoring at apply time in case the
  doc drifted while parked). Living in the CRDT means every participant sees the same pending
  card and decisions survive refreshes; the record ends as an in-document audit entry
  (status + decidedBy). New events approval.requested/granted/rejected; run statuses
  awaiting_approval/rejected; `--no-approval` opts out; timeout marks the proposal so no stale
  card lingers. Verified live (fresh room): agent proposed → waited → **Approve clicked** →
  typed in; negative control (no click → timeout) + reject/approve/timeout integration tests
  (15 conductor tests). Still v0: whole-file proposal (not per-hunk), single reviewer.

## Phase 3 — Beta

| Component | Status | Notes |
|---|---|---|
| Replayable timeline | ✅ 2026-07-19 | The relay records a per-room timeline (services/collab-relay/timeline): CRDT updates + presence join/leave, each stamped with a monotonic seq (the room actor's processing order — a total order, so no HLC needed for one relay) and wall-clock ms, to JSONL. `GET /timeline/{room}` serves it (localhost CORS). The web replay player (apps/web/src/ide/replay + /w/[room]/replay) fetches it and rebuilds document state at any scrub point by applying CRDT updates up to that index (rebuild-from-scratch; Yjs applies thousands/ms), rendering the active file in a read-only Monaco with a file picker, play/pause, 0.5–8× speed, an activity heatbar, and the participant set at that moment. "Git + multiplayer replay": every human keystroke AND every agent edit is here because it all flowed through the recorded CRDT. Verified live: recorded a 17-event session (human + scribe agent), scrubbed from the original file → final (agent doc-comment + human edits appear), presence rewinds too. 4 timeline Go tests + 2 endpoint tests. Caught a real bug: Monaco mounts async setting a ref, which didn't re-trigger the render effect — fixed with an editorReady state dep |
| Firecracker execution plane | ⬜ | not buildable on macOS (needs KVM); currently Docker (see Runtime delta above) |
| Replay: terminal + agent-reasoning channels | ⬜ | timeline Kind field is the extension point; pty/agent-step capture next |
| Graph artifacts, Qdrant, preview URLs, Reviewer/Debugger agents, canary deploys | ⬜ | |

### Phase-3 v0 deltas (deliberate)

- **Timeline: JSONL files + rebuild-from-scratch seek, not zstd S3 segments + snapshots** — the
  Recorder/reader interface is the seam (doc 12 §3–4); base64 CRDT payloads in JSON, fine at
  workspace scale. Ordering is the relay actor's single-thread order (total), not cross-relay
  HLC. Only CRDT + presence captured so far (not pty/agent-reasoning).


