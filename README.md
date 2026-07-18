# Atelier

**AI-native collaborative coding platform** — multiplayer cloud IDE + autonomous agents +
repository intelligence + replayable timelines. Architecture: [BLUEPRINT.md](BLUEPRINT.md).

## Status

Phase 1 (MVP) complete; Phase 2 (intelligence) underway — see [PROGRESS.md](PROGRESS.md).
Working today: real-time multiplayer code editing (Yjs CRDTs over a custom binary WS
protocol), presence + named remote cursors, multi-file rooms, durable persistence with
client-driven log compaction, offline edits reconciled on reconnect, relay-crash recovery,
**shared terminals** (real shells bridged into rooms by a workspace host — optionally inside
a resource-limited, network-isolated container), **CRDT ⇄ filesystem sync** (editor,
terminal, and disk agree), **signed-token auth** (a control-plane `core-api` mints
short-lived room tokens; the relay verifies them and derives identity from claims, not client
assertions), **live observability** (OTel metrics → Prometheus → a provisioned Grafana
dashboard, including the browser-measured keystroke-RTT SLI), **repository intelligence**
(a Rust tree-sitter indexer serving symbol search, a call graph / find-references, and hybrid
semantic+lexical retrieval — all staying fresh as you type), **autonomous agents** (a
retrieval-grounded agent joins a room as a first-class participant and types reviewable edits
into the live document; runs are event-sourced — and it runs on a zero-token scripted model
provider, with a real model as a one-step drop-in), and an automated Playwright multiplayer
harness.

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

# terminal 4 (optional) — doc-fs: syncs the room's files to that same directory
pnpm --filter @atelier/doc-fs exec tsx src/main.ts --room demo --dir ./data/workspaces/demo
# (--clone <git url> populates an empty workspace from a repo)

# terminal 5 (optional) — indexer: symbol search over the workspace (needs Rust)
cargo run --release --manifest-path services/indexer/Cargo.toml -- --dir ./data/workspaces/demo
# → http://localhost:8789; the IDE's "Intelligence" panel appears when it's reachable

# one-shot (optional) — run an agent: it joins the room and documents a symbol
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --goal "document greet"
# zero tokens (scripted provider); watch "scribe (agent)" type into the shared doc
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
services/workspace-host  Go: joins rooms as `host`, bridges real PTYs into the terminal channel
services/doc-fs          TS: CRDT ⇄ filesystem sync (+ git clone) for a workspace directory
services/indexer         Rust: tree-sitter indexer — symbols, call graph, hybrid retrieval
services/conductor       TS: agent orchestrator + model-gateway (scripted/zero-token) — scribe agent
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
