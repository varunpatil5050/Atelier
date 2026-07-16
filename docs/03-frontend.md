# 03 — Frontend Architecture (Blueprint §4)

The frontend is two applications sharing one codebase: a **dashboard** (server-rendered,
CRUD-shaped) and the **IDE** (a client-rendered real-time system that happens to run in a
browser). Treat the IDE like a game engine embedded in a web app: it has its own runtime,
its own scheduler concerns, and React is its UI layer — not its architecture.

---

## 1. Folder structure (apps/web)

```
apps/web/
├── app/                              # Next.js App Router
│   ├── (marketing)/                  # static/ISR routes
│   ├── (dashboard)/
│   │   ├── layout.tsx                # RSC: org context, nav
│   │   ├── workspaces/page.tsx
│   │   ├── agents/page.tsx           # fleet view of agent runs
│   │   └── settings/…
│   ├── w/[workspaceId]/
│   │   ├── page.tsx                  # RSC shell: authz + manifest inline, then client island
│   │   └── replay/[sessionId]/page.tsx
│   └── api/…                         # BFF-only routes (auth callbacks, token mint)
├── src/
│   ├── ide/                          # THE IDE RUNTIME (framework-agnostic core + React skin)
│   │   ├── kernel/                   # non-React: lifecycle, service registry, command bus
│   │   │   ├── IdeKernel.ts          # boot, service wiring, dispose
│   │   │   ├── CommandRegistry.ts    # every user action is a command (id, run, keybinding)
│   │   │   ├── KeybindingService.ts
│   │   │   └── ServiceContainer.ts   # typed DI: get(ConnectionService) etc.
│   │   ├── connection/               # WS transport (doc §6)
│   │   │   ├── WsConnection.ts       # single socket, binary framing, channels
│   │   │   ├── ChannelMux.ts         # channel registry: crdt|pty|exec|presence|agent
│   │   │   ├── Backoff.ts            # decorrelated jitter reconnect
│   │   │   └── OfflineQueue.ts
│   │   ├── collab/
│   │   │   ├── DocRegistry.ts        # Y.Doc per workspace; subdocs per file
│   │   │   ├── AwarenessService.ts   # cursors/presence (humans + agents)
│   │   │   ├── UndoScopes.ts         # per-user undo managers
│   │   │   └── persistence/IndexedDbCache.ts   # y-indexeddb offline mirror
│   │   ├── editor/                   # doc §4
│   │   │   ├── EditorHost.ts         # interface: mount/model/decorations/diff
│   │   │   ├── monaco/…              # MonacoHost impl, worker config, y-monaco glue
│   │   │   ├── EditorPool.ts         # reuse editor instances across tabs
│   │   │   └── decorations/          # remote cursors, agent highlights, blame ghosts
│   │   ├── terminal/                 # doc §5.3
│   │   ├── files/                    # file explorer domain (tree model, watchers, DnD)
│   │   ├── agents/                   # AI panel domain: task list, step stream, approvals
│   │   ├── intelligence/             # search, repo graph client, peek providers
│   │   ├── replay/                   # timeline player (doc 12 client section)
│   │   ├── run/                      # execution: run configs, log streams, preview panes
│   │   └── layout/                   # dockable panes, golden-layout-style tree, persistence
│   ├── components/                   # shared presentational (Radix-based primitives)
│   ├── stores/                       # zustand stores (shell) + jotai atoms (fine-grained)
│   ├── lib/api/                      # TanStack Query hooks; generated client from OpenAPI
│   ├── lib/protocol/                 # WS frame codecs shared w/ relay (generated + handwritten)
│   └── themes/                       # token definitions → CSS vars + Monaco/xterm themes
└── tests/  (vitest unit · playwright e2e · playwright-multiplayer harness)
```

**Domain-driven rule:** each `src/ide/<domain>/` owns its state, its WS channel handlers, its
commands, and its React components. Cross-domain communication goes through the command bus or
events — never direct imports of another domain's store. This is what keeps 15 panels from
becoming one 40k-line ball.

## 2. Rendering & caching strategy

- **Marketing:** static + ISR at the CDN.
- **Dashboard:** RSC reads from core-api server-side (no client waterfall), TanStack Query
  hydrates for interactivity; mutations optimistic with rollback.
- **IDE:** one RSC pass inlines the *workspace manifest* (authz result, room token, file-tree
  head snapshot, theme, user prefs) → client island boots `IdeKernel`. Everything after boot
  is WS-driven; HTTP only for cold queries (search, history).
- **Asset caching:** immutable hashed chunks, Monaco + xterm + language grammars in separate
  lazy chunks; service worker precaches the IDE shell for repeat-visit boot < 1s (doc 11 §5
  performance budgets).

## 3. State management (the four-layer rule)

| Layer | Tool | Examples | Invariant |
|---|---|---|---|
| Document state | **Yjs** | file buffers, shared debug notes | Never mirrored into stores; React reads via `useSyncExternalStore` adapters with selector-level granularity |
| Realtime ephemeral | **Jotai atoms** | remote cursors, presence, agent step stream, terminal viewport | Updated from WS handlers via `store.set` outside React; atomFamily keyed by (paneId, userId) |
| Shell state | **Zustand** | layout tree, open editors, active pane, connection status | Serialized to localStorage (layout persistence) |
| Server state | **TanStack Query** | workspace list, tasks, repo metadata | Invalidated by WS events (`agent.task.updated` → `queryClient.invalidateQueries(['tasks'])`) |

**Optimistic UI:** CRDT ops are natively optimistic (apply locally, sync later). Metadata
mutations (rename file, create task) use Query's optimistic mutations with server
reconciliation; conflicts surface as inline toasts with "keep mine/theirs" only where the
server can't merge (rare — most metadata is last-writer-wins with audit).

## 4. Editor architecture

- **`EditorHost` interface** isolates Monaco: `openModel(uri)`, `applyDecorations(set)`,
  `revealRange`, `diff(base, modified)`. Monaco loads in a lazy chunk; its workers (TS, JSON,
  editor core) are configured with a strict CSP-compatible worker factory.
- **Model lifecycle:** one `Y.Text` per file (subdoc), bound to a Monaco model via `y-monaco`
  only while visible. Background files keep Yjs state but no Monaco model (memory).
  `EditorPool` recycles editor instances across tab switches — creating a Monaco editor is
  ~50ms; swapping models is ~2ms.
- **Undo:** `Y.UndoManager` scoped to the local user's origin — undo never reverts a
  collaborator's or agent's edits (the #1 multiplayer editor bug).
- **Decorations pipeline:** a single `DecorationOrchestrator` merges providers (remote
  cursors, agent-edit highlights, search matches, debug lines, blame ghosts) and applies them
  in one `deltaDecorations` call per frame — Monaco decoration churn is a classic perf killer.
- **LSP:** `monaco-languageclient` over a dedicated WS channel (`lsp`) proxied by the relay to
  the workspace VM's language servers. Requests are cancelled on doc-version advance.

## 5. Core surfaces

### 5.1 Collaborative editor + live cursors
Remote selections render as Monaco decorations from the Awareness protocol (doc 04 §5):
colored selection background + name flag, throttled to animation frames, positions transformed
through pending local ops so they never "swim" during fast typing. **Agent cursors** are
identical infrastructure with an agent badge and a distinct animation (smooth interpolated
motion — agents type in bursts; interpolation makes their activity legible).

### 5.2 File explorer
Tree state is a Yjs map (shared expansion is *not* shared — expansion is local; the tree
*content* is derived from the workspace FS event channel). Virtualized (TanStack Virtual) for
10k+ node repos; inline rename/create with optimistic FS ops; drag-drop with capability check;
git status + agent-touched badges as decorations.

### 5.3 Terminal UI
xterm.js + WebGL renderer. Input → `pty` channel frames with client sequence numbers; output
frames carry server sequence for gap detection (gap → request replay from last seq).
Scrollback capped at 50k lines client-side (full history lives in the timeline). Multiple
terminals = multiple pty channel streams on the same socket. **Shared mode:** presence-labeled
input multiplexing with an optional "driver lock" (doc 04 §7).

### 5.4 AI side panel
Task composer (goal, scope selector: files/dir/repo, budget), live **step stream** (each
`agent.step.*` event renders as a collapsible card: reasoning summary, tool calls with I/O,
diffs), and the **approval surface**: agent-proposed diffs render in Monaco diff editors with
per-hunk accept/reject that maps to CRDT ops on accept. The panel is a viewer over timeline
events — the same components power live view and replay.

### 5.5 Repo graph viewer
Force-directed module graph (WebGL via Sigma.js/graphology) fed by `graph-query` API:
files/modules as nodes sized by symbol count, edges = imports/calls; click-through to symbol
lists; "blast radius" mode highlights transitive dependents of the current diff — this view is
a recruiter-demo centerpiece and also genuinely used by the Reviewer agent's UI explanations.

### 5.6 Debugging timeline & execution logs
DAP (Debug Adapter Protocol) sessions run in the workspace VM, proxied like LSP. The
**debugging timeline** renders breakpoint hits, stack captures, and watched-value changes as
events on the session timeline — collaborative: everyone sees the same paused state;
step-control uses the driver lock. Execution logs are virtualized append-only views over
`exec` channel streams with structured-log detection (JSON lines → expandable rows).

### 5.7 Replay system (client)
Doc 12 owns the format; the client player fetches segment manifests, streams frames, and
drives the *same* rendering surfaces (editor host, xterm, agent panel) in "playback mode" —
components take an event source that is either "live socket" or "replay cursor". Scrubbing
seeks to nearest snapshot then fast-forwards; playback speed 0.5×–16×.

## 6. WebSocket management

One socket per workspace. Binary frames: `[u8 channel][u8 flags][u16 streamId][varint len][payload]`
(full protocol table in doc 15 §6). Rules:

- **Reconnect:** decorrelated-jitter backoff (base 200ms, cap 10s); on reconnect: re-auth with
  fresh room token → Yjs SyncStep1 (state vector) → awareness re-broadcast → pty gap replay.
- **Backpressure:** client monitors `bufferedAmount`; if > 256KB, drop awareness updates
  first, then coalesce CRDT frames (they merge losslessly), never drop pty input.
- **Liveness:** ping/pong every 15s with RTT sampling (drives the latency indicator and
  adaptive batching).

## 7. Offline support

- `y-indexeddb` mirrors all open docs; edits offline accumulate as Yjs updates.
- On reconnect, state-vector diff sync reconciles automatically (CRDT superpower — doc 04 §8
  covers server-side guards for long-offline divergence).
- Non-CRDT mutations queue in `OfflineQueue` with idempotency keys; replay on reconnect;
  terminal/exec panes render an explicit "disconnected" state (never fake liveness).
- Explicit UX: an offline banner with pending-op count. Silent divergence is worse than
  visible degradation.

## 8. Theme system & accessibility

- Tokens (`--surface-*`, `--accent-*`, `--syntax-*`) defined once, mapped to Tailwind theme,
  Monaco theme JSON, and xterm theme objects by a generator script — one palette, three
  renderers, no drift. Light/dark/high-contrast + per-user syntax palette.
- A11y: full command-bus keyboard coverage (every mouse action has a command), Radix
  primitives for dialogs/menus, `aria-live` regions for agent activity announcements, focus
  management across dockable panes, reduced-motion mode disables cursor interpolation.
  Terminals expose a screen-reader line buffer (xterm a11y addon).

## 9. Plugin architecture (Beta phase)

- Plugins are sandboxed iframes (or workers for headless) speaking a postMessage RPC with a
  **capability-scoped API**: `atelier.panels.register`, `atelier.commands.register`,
  `atelier.fs.read` (scoped), `atelier.agent.registerTool` (org-approved only).
- Manifest declares capabilities; users grant per-workspace. No plugin touches the raw socket
  or Yjs docs — they get mediated, rate-limited views. This is the same trust model as the
  agent tool sandbox, deliberately.

## 10. Performance practices (budgets in doc 11 §5)

- Keystroke → local echo must never wait on React: y-monaco applies to the model directly.
- All lists virtualized ≥ 200 items; agent step stream windowed with height estimation.
- `React.startTransition` for panel-level updates; `useDeferredValue` for search-as-you-type.
- Web workers: syntax-highlight for non-focused diff views, search result highlighting,
  replay frame decoding. Comlink for ergonomics.
- Memory: editor pool + model eviction (LRU, dirty-pinned), detached-DOM leak checks in CI
  via Playwright + CDP heap snapshots on the multiplayer harness.
