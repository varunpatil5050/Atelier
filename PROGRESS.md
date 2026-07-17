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
| 10 | Indexer v0 (tree-sitter → symbols → search) | ⬜ next | Phase 2 boundary — first intelligence-plane component (Rust) |

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
## Phase 3 — Beta — not started
