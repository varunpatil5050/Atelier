# Atelier

**An AI-native collaborative coding platform** — a real-time multiplayer cloud IDE where
humans and AI agents work in the same live document, backed by repository intelligence,
full session replay, and shareable preview URLs. Polyglot monorepo: **Go** (collaboration +
execution plane), **Rust** (intelligence plane), **TypeScript** (IDE + agents).

Architecture blueprint: [BLUEPRINT.md](BLUEPRINT.md) (15 docs) · increment-by-increment
build log: [PROGRESS.md](PROGRESS.md).

## What works today

- **Real-time multiplayer editing** — Yjs CRDTs over a custom binary WebSocket protocol;
  presence and named remote cursors; multi-file rooms; durable persistence with
  client-driven log compaction; offline edits reconcile on reconnect; kill the relay
  mid-session and no acknowledged edit is lost.
- **Shared terminals** — real shells bridged into rooms by a workspace host, optionally
  inside a resource-limited, network-isolated Docker container. One shell, visible to
  every participant.
- **CRDT ⇄ filesystem sync** — the editor, the terminal, and the disk agree; `--clone`
  boots a workspace from any git repo.
- **Repository intelligence** (Rust + tree-sitter) — symbol search, a call graph with
  find-references and blast-radius summaries, and hybrid semantic+lexical retrieval (RRF
  fusion with provenance) — all re-indexed live as you type.
- **Autonomous agents** — a retrieval-grounded agent joins the room as a first-class
  participant, narrates its reasoning step by step into the room, and proposes reviewable
  edits gated behind human approval in the IDE. Runs are event-sourced; the scripted
  model provider spends **zero tokens**, and a real model drops in behind the same
  interface.
- **Replayable timeline** — the relay records every room's history; scrub any session and
  watch the document rebuild moment by moment — keystrokes, agent edits, the agent's own
  reasoning, and who was present, all faithful to that point in time.
- **Preview URLs** — start a dev server inside a workspace and it's auto-detected and
  reverse-proxied to a shareable `{port}--{room}.preview.<domain>` URL (HTTP **and**
  WebSocket), embedded live in the IDE.
- **Signed-token auth** (optional) — a control-plane `core-api` mints short-lived HMAC
  room tokens; the relay derives identity from token claims, never client assertions.
- **Live observability** — OTel → Prometheus → a provisioned Grafana dashboard, including
  the flagship SLI: keystroke round-trip time, measured in the browser.
- **Tested end to end** — Go (`-race`), Rust, and TypeScript suites plus a Playwright
  multiplayer harness that boots the real stack and asserts cross-client convergence
  (~7 ms propagation).

## Quickstart

Requirements: Node ≥ 22, pnpm 9, Go ≥ 1.26.

```sh
pnpm install

# terminal 1 — collab relay (Go)
go run atelier.dev/services/collab-relay/cmd/collab-relay
# → ws://localhost:8787, persists rooms to ./data/rooms

# terminal 2 — web IDE (Next.js)
pnpm --filter @atelier/web dev

# terminal 3 (optional) — workspace host: bridges a real shell into a room
go run atelier.dev/services/workspace-host/cmd/workspace-host --room demo --dir ./data/workspaces/demo
# add --runtime docker to run shells inside a resource-limited, network-isolated
# container (bind-mounts the dir; flags: --image --memory --cpus --pids-limit --network)
# add --preview-router http://localhost:8790 to auto-detect dev servers → shareable preview URLs

# terminal 3b (optional) — preview-router: proxies a workspace's dev server to a URL
go run atelier.dev/services/preview-router/cmd/preview-router
# → :8790; run a dev server in the room's terminal and the IDE "Preview" pane picks it up
#   at http://{port}--demo.preview.localhost:8790/

# terminal 4 (optional) — doc-fs: syncs the room's files to that same directory
pnpm --filter @atelier/doc-fs exec tsx src/main.ts --room demo --dir ./data/workspaces/demo
# (--clone <git url> populates an empty workspace from a repo)

# terminal 5 (optional) — indexer: symbol search over the workspace (needs Rust)
cargo run --release --manifest-path services/indexer/Cargo.toml -- --dir ./data/workspaces/demo
# → http://localhost:8789; the IDE's "Intelligence" panel appears when it's reachable

# one-shot (optional) — run an agent: it joins the room and proposes a doc comment
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --goal "document greet"
# zero tokens (scripted provider). By default it PARKS on a proposal — approve or
# reject it in the IDE's review card; only then does "scribe (agent)" type it in.
# (--no-approval applies directly, skipping the gate.)
```

With both running, the editor, the terminal, and the filesystem agree: edit `main.ts` in the
browser and `node main.ts` in the shared terminal runs your edit; `echo >> main.ts` in the
terminal appears in everyone's editor. (These two processes merge into the workspace
guest-agent when execution moves into containers — blueprint doc 05 §3.)

Open the printed URL, join a room, then open the same room in a second tab: every keystroke,
cursor, and selection syncs live, and the terminal is shared — one shell, visible to all
participants. Kill the relay mid-session and restart it — clients reconnect and no
acknowledged edit is lost.

## Tests

```sh
pnpm --filter @atelier/protocol test   # TS codec + shared golden vectors
pnpm --filter @atelier/doc-fs test     # CRDT ⇄ filesystem sync vs a real relay
go test -race ./...                    # relay, core-api, authtoken, full-stack PTY integration
cargo test --manifest-path services/indexer/Cargo.toml   # tree-sitter extraction + ranking + retrieval
pnpm --filter @atelier/conductor test  # agent run vs a real relay (gateway, run log, scribe)
pnpm --filter @atelier/web e2e         # Playwright multiplayer harness (boots everything)
```

## Layout

```
apps/web                 Next.js IDE (Monaco + Yjs + xterm; IDE runtime in src/ide; e2e/)
packages/protocol        Binary WS frame codec (TS) + golden fixtures (cross-language)
packages/client          Shared room client: WsConnection + AtelierProvider (browser + Node)
pkg/wire                 Same codec in Go, shared across all Go services
pkg/authtoken            Compact HMAC room/session tokens (Mint/Verify)
services/collab-relay    Go relay: room actors, update log + compaction, awareness, PTY routing, token enforcement
services/core-api        Go control plane: dev sessions, workspaces, room-token minting (Postgres or in-memory)
services/workspace-host  Go: joins rooms as `host`, bridges real PTYs into the terminal channel; detects dev-server ports → preview-router
services/preview-router  Go: reverse-proxies a workspace's dev server to a shareable URL ({port}--{room}.preview.<domain>, HTTP+WS)
services/doc-fs          TS: CRDT ⇄ filesystem sync (+ git clone) for a workspace directory
services/indexer         Rust: tree-sitter indexer — symbols, call graph, hybrid retrieval
services/conductor       TS: agent orchestrator + model-gateway (scripted/zero-token) — scribe agent
services/collab-relay/timeline   Go: per-room replay recorder (CRDT + presence, JSONL); served at GET /timeline/{room}
tests/integration        Cross-service Go tests (relay + host + real shell)
docs/                    Full architecture blueprint (15 documents)
```

## Authentication (optional)

The quickstart above runs **tokenless** — fine for local dev. To enforce auth, run core-api
and start the relay with secrets:

```sh
docker compose up -d                        # Postgres for core-api (optional; falls back to in-memory)

SESSION_SECRET=$(openssl rand -hex 24) \
ROOM_TOKEN_SECRET=$(openssl rand -hex 24) \
DATABASE_URL=postgres://postgres:atelier@localhost:5433/atelier \
  go run atelier.dev/services/core-api/cmd/core-api        # :8788

RELAY_TOKEN_SECRET=$ROOM_TOKEN_SECRET \
RELAY_SERVICE_SECRET=$(openssl rand -hex 24) \
  go run atelier.dev/services/collab-relay/cmd/collab-relay
```

With `RELAY_TOKEN_SECRET` set, participants must present a room token minted by core-api
(`RELAY_TOKEN_SECRET` must equal core-api's `ROOM_TOKEN_SECRET`); services (workspace-host,
doc-fs) authenticate with `RELAY_SERVICE_SECRET`. The web app fetches a session + per-connect
room token automatically and shows a **🔒 signed** badge; identity comes from the token's
claims, never the client-asserted hello.

## Observability

Relay and core-api expose Prometheus metrics on `/metrics` (OTel SDK). Bring up the
dashboard stack and open Grafana — datasource and the **Atelier — Dev Overview** dashboard
are auto-provisioned:

```sh
docker compose up -d prometheus grafana   # Prometheus :9090, Grafana :3001 (anonymous)
```

The dashboard shows live connections/rooms, frames-per-second by channel, broadcast fan-out,
core-api latency, and the flagship SLI: **keystroke round-trip time**, measured in the
browser and beaconed to `core-api` (`POST /v1/rum`). Prometheus scrapes the host-run services
via `host.docker.internal`.

The TS and Go codecs are pinned to each other by `packages/protocol/fixtures/frames.json` —
both test suites load the same vectors.
