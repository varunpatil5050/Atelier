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
- **Autonomous agents (multi-agent)** — a full Planner→Coder→Tester→Reviewer team joins the
  room as first-class participants and narrates its reasoning into it. A **planner** turns a
  free-form goal (`document all`, `document app.ts`) into a plan and delegates to a **scribe**,
  which proposes reviewable edits gated behind human approval; a **reviewer** independently
  scores each proposal by call-graph blast radius; a **tester** runs the workspace's code and
  reports pass/fail into the room. Runs are event-sourced; the scripted model provider spends
  **zero tokens**, and a real model drops in behind the same interface.
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

## System design

Five planes around one shared document. Every collaborative feature — human edits, agent
edits, agent reasoning, proposals, presence — is state in a Yjs CRDT relayed through a
per-room actor, which is why everything is simultaneously multiplayer, persistent, and
replayable. (Full detail: [BLUEPRINT.md](BLUEPRINT.md) and `docs/01–15`.)

```mermaid
flowchart LR
  subgraph P["Participants — one binary WS protocol, one client library"]
    IDE["Web IDE<br/>Next.js · Monaco · xterm · Yjs"]
    AGT["conductor agents<br/>planner · scribe · reviewer · tester"]
    DFS["doc-fs<br/>CRDT ⇄ filesystem"]
  end

  subgraph C["Collaboration plane · Go"]
    RLY["collab-relay<br/>room actors · update log · awareness<br/>PTY routing · timeline recorder"]
    LOGS[("persisted room logs<br/>+ replay timelines")]
  end

  subgraph E["Execution plane · Go"]
    WSH["workspace-host<br/>PTYs behind the Runtime seam<br/>(host shell or Docker container)"]
    DEV["dev server<br/>spawned in the shared shell"]
    PRV["preview-router<br/>reverse proxy → shareable URLs"]
  end

  subgraph I["Intelligence plane · Rust"]
    IDX["indexer<br/>tree-sitter symbols · call graph<br/>hybrid retrieval"]
  end

  subgraph K["Control plane · Go"]
    API["core-api<br/>sessions · workspaces · room tokens"]
  end

  DIR[("workspace directory")]
  OBS["Prometheus → Grafana"]

  IDE <--> RLY
  AGT <--> RLY
  DFS <--> RLY
  WSH <--> RLY
  RLY --- LOGS
  DFS <--> DIR
  DIR -->|file events| IDX
  IDE -->|symbols · refs · content| IDX
  AGT -->|retrieval grounding| IDX
  IDE -->|mint room token| API
  WSH -->|detects listening ports| DEV
  WSH -->|register room + port| PRV
  PRV -->|proxy HTTP + WS| DEV
  IDE -->|embedded preview| PRV
  RLY -.->|metrics| OBS
  API -.->|metrics| OBS
  IDE -.->|keystroke-RTT RUM| API
```

### Core ideas

1. **One protocol, one client, every participant.** Browsers, the filesystem bridge, the
   terminal host, and AI agents all speak the same binary WebSocket framing
   (`[channel][flags][streamId][len][payload]` — channels for CTRL, CRDT, awareness, PTY)
   through the same client library (`@atelier/client`, browser + Node). An agent isn't a
   bolted-on system — it's just another participant with presence and a cursor.
2. **Single-homed room actors give total order.** Each room lives on one relay goroutine.
   Every update passes through it in a single sequence — so persistence is an append log,
   late-join is replay, and the recorded timeline is totally ordered without distributed
   clocks.
3. **The document is the API.** The file map, agent proposals (`Y.Map("proposals")`), and
   the agent's step-by-step reasoning (`Y.Array("agent_trace")`) are CRDT structures in
   the room itself. Anything written there is automatically synced to every peer, survives
   restarts, and shows up in replay — features compose instead of integrate.
4. **The intelligence loop closes live.** Keystroke → CRDT → doc-fs writes disk → the
   indexer re-parses within a debounce → search, call graph, and retrieval reflect the
   edit — so the agent's next retrieval is grounded in code typed seconds ago.
5. **Interface seams ladder to production.** Every external dependency sits behind a seam
   with a real, zero-dependency v0: `Runtime` (host shell → Docker → microVM guest-agent),
   `ModelProvider` (deterministic scripted → real model API), `Embedder` (feature-hash →
   learned embeddings), `Store` (in-memory → Postgres), preview registration (port
   watcher → guest-agent). Swapping a rung is a deployment change, not an architecture
   change.
6. **Optional planes degrade by design.** The IDE runs on nothing but relay + web;
   intelligence, auth, terminals, previews, and observability each light up when their
   service is reachable and detach cleanly when it isn't.

### Life of a keystroke

Monaco edit → y-monaco applies it to the local Y.Doc → update frame over WS → the room
actor appends it to the log **and** the timeline, then broadcasts → peers converge (a few
ms) → doc-fs debounces it to disk → the indexer re-indexes the file → symbol search and
find-references answer with the new code. The round trip is measured in the browser and
beaconed to core-api as the keystroke-RTT SLI on the Grafana dashboard.

### Life of an agent run

`conductor --role planner --goal "document all"` → the **planner** joins the room, asks the
model-gateway to interpret the goal, and enumerates the workspace's symbols → for each it
**delegates to a scribe**. Each scribe joins over the same protocol (purple presence chip) →
pulls grounding facts from the indexer (definition, callers, blast radius) → prompts the
model-gateway (scripted provider — zero tokens) → writes a **Proposal** into the shared doc
and narrates every step into `agent_trace` (visible live in the sidebar). A **reviewer**
agent watching the room independently scores each proposal by call-graph blast radius and
attaches a verdict to the card (`approve` / `concerns`) → a human clicks **Approve** in the
IDE → the scribe types the patch into the CRDT, re-anchored against concurrent edits →
doc-fs persists it, the timeline records it, and the event-sourced run log folds to
`applied`. Planner, scribe, and reviewer reasoning all interleave in the one trace, live and
in replay. Rejecting leaves the document untouched; walking away times the proposal out.
(For a single symbol, skip the planner: `conductor --goal "document greet"`.)

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

# agents (optional, zero tokens — scripted provider). Each joins the room as a participant.
# scribe: proposes a doc comment for one symbol; PARKS until you approve in the IDE's card.
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --goal "document greet"
# reviewer: long-running — scores each proposal by call-graph blast radius (run alongside).
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --role reviewer
# planner: decomposes a free-form goal and delegates to a scribe per symbol.
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --role planner --goal "document all"
# tester: runs the workspace's command and reports pass/fail into the room.
pnpm --filter @atelier/conductor exec tsx src/main.ts --room demo --role tester --cmd "node test.js" --cwd ./data/workspaces/demo
# (--no-approval applies directly, skipping the human gate.)
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
