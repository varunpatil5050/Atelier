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
- **conductor: the full Planner/Coder/Tester/Reviewer DAG exists (scripted)** — all four of
  doc 07's roles interact through the room: the Planner decomposes a goal and delegates to the
  Coder (scribe), which proposes; the Reviewer scores by blast radius; the Tester runs the code
  and reports pass/fail; the human decides. The load-bearing shape is real (event-sourced runs,
  agents-as-room-participants, retrieval-grounded prompts, reviewable CRDT edits, execution
  behind a Runner seam, multi-agent orchestration via shared CRDT maps + delegated runs). Still
  v0: the scripted model provider (real model is one isolated step behind ModelProvider); the
  Tester runs on the host rung (sandbox Runner drops in later); no Debugger role yet. See the
  Planner/Reviewer/Tester rows in Phase 3.
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
| Replay: agent-reasoning channel | ✅ 2026-07-20 | The scribe now narrates its own reasoning into a shared `Y.Array("agent_trace")` (services/conductor/src/trace.ts): a step per phase (started/plan/retrieve/generate/propose/decision/apply/done), each carrying the runId, agent name, seq, a human label, and a detail line grounded in the real retrieval ("found fn greet at app.ts:1; 2 callers across 1 file"). Because the trace lives in the room CRDT, it is **both** live-visible **and** replayable for free — it rides the same recorded CRDT updates the timeline already captures, so no relay change was needed. The IDE shows a live **Agent activity** feed in the sidebar (apps/web/src/ide/components/AgentActivity.tsx) that appears only once an agent acts; the replay player reconstructs the trace at each scrub point and renders it in an **Agent reasoning (at this point)** lane (ReplayPlayer). Both use one shared presentational list (AgentStepList) with color-coded step badges (agentTrace.ts), so a session looks identical live and rewound. Verified live: watched all 8 steps stream into the sidebar as the agent worked, approved in-browser (decision→apply→done appended live), then in replay scrubbed to the end (comment applied + full 8-step lane) and back to mid-session (10/29: original file, agent present in presence bar, reasoning lane correctly absent because no trace steps existed in the doc yet). Conductor 15 tests (run.test.ts now asserts the step sequence + grounded detail land in a peer's array). |
| Preview URLs (running dev servers → shareable links) | ✅ 2026-07-20 | New **services/preview-router** (Go): a workspace declares a listening port; the router registers `{room, port}` → a backend target and reverse-proxies `http://{port}--{room}.preview.localhost:8790/` (subdomain routing — the app is served at root, no path rewrite) with a `/_p/{room}/{port}/` fallback. HTTP **and WebSocket** (live-reload dev servers work), a TTL registry with heartbeat self-healing, and a private-by-default share-token seam (dev-open by default; `PREVIEW_SHARE_SECRET` gates with room-scoped HMAC tokens — same authtoken as room tokens). Registration is the same API the microVM guest-agent's netlink watcher will call — only the caller moves. **workspace-host** grew preview auto-detection (services/workspace-host/preview): it scans the workspace's process subtree (lsof + ps descendant walk) for listening ports it opened — not the relay, the web dev server, or anything else — and registers/heartbeats/unregisters them with the router (`--preview-router` flag, host runtime only; a container's ports live in the guest, the microVM end state). IDE **PreviewPane** (apps/web) polls the router and embeds the selected preview in an iframe with the shareable URL + reload/collapse; empty state prompts to start a dev server. 12 router Go tests (subdomain + path routing, prefix strip, 502-on-miss, control-vs-proxy separation, register-secret + share-token gates, **WebSocket round-trip**) + 7 workspace-host preview tests (lsof/ps parsers, descendant-set, dedupe/scoping, watcher register/unregister-on-change diff, drain). Verified live: router proxied a real page through the pretty subdomain URL (in-app browser resolves `*.preview.localhost`), and the IDE PreviewPane rendered a live `:8000` dev server in its iframe with the shareable URL shown. |
| Reviewer agent (multi-agent) | ✅ 2026-07-21 | The first second agent (blueprint doc 07's Planner→Coder→Tester→**Reviewer** graph — this is the Reviewer). A long-running participant `startReviewer` (services/conductor/src/review.ts) joins as "reviewer (agent)" (teal), watches `Y.Map("proposals")`, and for each pending proposal pulls the target's callers from the intelligence plane, asks the same model-gateway to score it, and writes a **Review** (verdict + grounded notes) into a **separate `Y.Map("reviews")`** keyed by proposalId — separate from proposals so the reviewer's write and the human's decision never LWW-clobber each other. Verdict is grounded in **blast radius**: `approve` for a doc-only change with low reach, `concerns` when >3 callers ("confirm the doc holds for all N call sites") or the insert doesn't name its symbol; it never auto-rejects — a human still decides, the review just informs. It narrates a "review" step into the same shared `agent_trace`, so scribe + reviewer reasoning interleave in the live feed and replay. Scribe now stamps `symbol` onto its proposal (self-describing); the ScriptedProvider branches on a `REVIEW_FACTS` block (one provider, two agent tasks); ProposalPanel renders the verdict badge + notes on the card. `--role reviewer` runs the watcher. +6 conductor tests (4 gateway review-branch + 2 full-stack: both verdict paths, idempotent across CRDT churn) → 21 total. Verified live: scribe proposed `document fmt` (4 callers) → reviewer flagged **concerns** on the card; `document greet` (1 caller) → **approve** — both agents present, reasoning interleaved. |
| Planner agent (multi-agent orchestration) | ✅ 2026-07-21 | The Planner of doc 07's Planner→Coder→Tester→Reviewer graph — it turns a **free-form goal** into a plan and drives the Coder, retiring the fixed "document <symbol>" grammar. `runPlan` (services/conductor/src/plan.ts) joins as "planner (agent)" (amber), asks the model-gateway to interpret the goal into a **directive** (ScriptedProvider gains a third branch on a `PLAN_GOAL` block → `{action:"document", scope:"symbol"\|"file"\|"all"}` — a keyword matcher standing in for the model's decomposition), expands the directive into concrete tasks via a new indexer endpoint, and then runs the **scribe once per task** — each flowing through the SAME reviewer + human-approval gate. New grammar: `document all` / `document everything`, `document <file>`, `document <symbol>`. Indexer grew **`GET /v1/symbols`** (`Index::list_symbols(path?)`, ordered by path+line) so the planner can enumerate; conductor `intel.symbols()` calls it. The planner narrates started→plan→delegate(×N)→done into the shared `agent_trace`, and the scribe/reviewer steps it spawns interleave there too — the IDE feed now labels each step by agent (planner/scribe/reviewer), with a "delegate" badge. `--role planner`. +8 tests (5 gateway plan-branch: all/file/symbol/unsupported/via-provider; 2 full-stack plan.test.ts: decompose "document all" → 3 scribes, class filtered out, + unsupported-goal fail; 1 Rust list_symbols) → 28 conductor + 20 Rust. Verified live in room planq: `--role planner --goal "document all"` on 3 undocumented functions → planner + scribe + reviewer all present, decomposed into add/multiply/clamp, each proposed → reviewed (approve) → approved → all 3 documented on disk. |
| Tester agent (DAG complete) | ✅ 2026-07-21 | The fourth and last role of doc 07's Planner→Coder→Tester→Reviewer graph — **all four now exist**. `runTester` (services/conductor/src/tester.ts) joins as "tester (agent)" (sky), runs the workspace's command, and records a **TestResult** (status/exitCode/output tail/duration) into the room's shared `Y.Map("tests")` — live to every participant and on the replay timeline — narrating a pass/fail `test` step into agent_trace. Execution sits behind a **`Runner` seam** (same interface-ladder as the workspace-host Runtime): `LocalRunner` (child_process, shell, timeout-kill, 16 KiB output cap) runs on the host now; a sandbox runner executing inside the workspace's Docker container (doc 05 §8 structured runs) drops in behind the same interface. IDE **TestStatus** panel shows the latest result (pass/fail badge, command, exit code, expandable output). `--role tester --cmd "…" [--cwd]`. +4 tests (full-stack pass + fail via a FakeRunner asserting the tests map + trace; LocalRunner real exit codes + timeout-kill) → 32 conductor. Verified live in room testq: `--cmd "node test.js"` on a passing test → ✓ pass; edited math.js on disk to introduce a bug → doc-fs synced it into the room → re-ran → **✗ fail exit 1** with the real `AssertionError: -1 !== 5` shown expanded in the IDE. |
| Firecracker execution plane | ⬜ | not buildable on macOS (needs KVM); currently Docker (see Runtime delta above) |
| Replay: terminal channel | ⬜ | timeline Kind field is the extension point; pty capture next |
| Graph artifacts, Qdrant, real model, canary deploys | ⬜ | the full agent DAG (Planner/Coder/Tester/Reviewer) is now built (scripted); wiring the real model behind ModelProvider is one isolated token-spending step; Debugger agent + graph/Qdrant upgrades remain |

### Phase-3 v0 deltas (deliberate)

- **Timeline: JSONL files + rebuild-from-scratch seek, not zstd S3 segments + snapshots** — the
  Recorder/reader interface is the seam (doc 12 §3–4); base64 CRDT payloads in JSON, fine at
  workspace scale. Ordering is the relay actor's single-thread order (total), not cross-relay
  HLC. Agent-reasoning now rides the CRDT too; the terminal/pty channel is the remaining
  replay extension.
- **Preview routing: single-node localhost router + lsof port detection, not Envoy edge +
  guest-agent netlink** — the registration API is the seam (doc 05 §7): the workspace-host's
  lsof/ps subtree scanner stands in for the microVM guest-agent's netlink watcher; a plain
  `httputil.ReverseProxy` per route stands in for the Envoy wildcard-TLS preview edge; both
  register the same `{room, port} → target` route. Host-runtime only (a container's listening
  sockets aren't in the host's tables — the guest-agent surfaces them in the microVM end
  state). Dev-open by default; the share-token gate is wired (HMAC, room-scoped) but off until
  `PREVIEW_SHARE_SECRET` is set. Subdomain routing needs wildcard DNS (`*.preview.localhost`
  resolves to loopback in Chromium; production sets a real wildcard cert) — the `/_p/` path
  route is the no-DNS fallback.


