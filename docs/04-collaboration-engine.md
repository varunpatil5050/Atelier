# 04 — Real-Time Collaboration Engine (Blueprint §5)

The collaboration plane is a fleet of Go **collab-relay** nodes hosting CRDT *rooms* (one room
= one workspace session), fronted by a **room-router**, persisting to JetStream + S3. Design
goals: p95 keystroke echo to peers ≤ 120 ms same-region, rooms of 50+ live participants
(humans + agents), zero data loss on node failure, and every event captured for replay.

---

## 1. OT vs CRDT — the actual tradeoff

| | OT (Google Docs lineage) | CRDT (Yjs/Automerge lineage) |
|---|---|---|
| Server role | **Required** central sequencer; transforms ops against concurrent ops | Optional; any peer merges; server is a persistence/fanout convenience |
| Correctness burden | Transformation functions notoriously hard (TP2 problem); each new data type = new transform matrix | Merge correctness is intrinsic to the type; hard part moved into the library |
| Offline / branching | Painful (long transform chains) | Natural (state-vector diff sync) |
| Memory | Lean (no tombstones) | Tombstone/metadata overhead (Yjs GC mitigates) |
| Intent preservation | Excellent with good transforms | Occasional counterintuitive interleaving on *identical-position* concurrent inserts (YATA minimizes) |

**Decision: CRDT.** Three product requirements force it: (a) offline-first reconciliation, (b)
agents editing concurrently from server-side processes without a global sequencer bottleneck,
(c) relay failover without op-log surgery — a new relay can assemble state from snapshot +
updates in any order. OT's lean memory doesn't outweigh owning transform correctness forever.

## 2. Yjs vs Automerge

| | Yjs | Automerge 2/3 |
|---|---|---|
| Algorithm | YATA, integrated GC of tombstones | RGA-family, columnar compressed history, full history retained by design |
| Update size | Very compact binary (v2 encoding); mergeable offline | Excellent columnar compression at rest; changes carry more metadata |
| Perf on huge docs | Excellent (B-tree internal, position clocks) | Much improved (Rust core) but heavier memory on long-lived text |
| Ecosystem | y-monaco, y-protocols (sync+awareness), y-indexeddb, battle-tested at scale | Growing; strong Rust/Swift story; weaker Monaco binding |
| History model | History pruned by GC (we keep history externally in the timeline) | History is first-class (built-in time travel) |

**Decision: Yjs.** The clincher: we already build a **superior external history system** (the
timeline, doc 12) — Automerge's built-in full history would be redundant storage, while its
memory cost hits our hottest path. Yjs's awareness protocol and Monaco binding are exactly the
production pieces we'd otherwise write. Automerge remains the right choice for apps that need
in-CRDT history; we don't.

## 3. Document model

- One **Y.Doc per workspace** acting as a container; each file is a **subdocument** (`Y.Doc`)
  holding one `Y.Text`, loaded lazily. Rationale: subdocs give per-file lazy load + per-file
  snapshots; a 10k-file repo must not require hydrating one monolithic doc.
- Non-file shared state in the root doc: `Y.Map` for shared run configs, `Y.Map` for review
  threads, `Y.Array` for shared debug annotations.
- **The filesystem is the source of truth for file *content* at rest; the CRDT is the source
  of truth for *live editing*.** A `doc-fs sync` component in the workspace guest applies
  debounced CRDT saves to disk (so terminals/compilers see saves), and external FS changes
  (generated files, `git checkout`) diff back into the CRDT as a single-origin transaction.
  Conflict rule: concurrent CRDT edits + external write → CRDT wins, external version parked
  as `file.orig` + user notification (rare; git operations pause doc-fs sync per-path).

## 4. Relay architecture (Go)

```
┌─ collab-relay node ────────────────────────────────────────────┐
│  WsGateway (epoll-friendly; gobwas/ws)                         │
│    └─ Conn: read pump → frame decode → room.Inbox (bounded)    │
│  RoomManager                                                   │
│    └─ Room (one goroutine owns state — no locks on hot path)   │
│        ├─ Y.Doc state (yrs via cgo OR pure-Go y-crdt port)     │
│        ├─ awareness table                                      │
│        ├─ broadcast ring buffer + per-conn send queues         │
│        ├─ persistence: batch appender → JetStream              │
│        └─ snapshotter: periodic encoded state → S3             │
│  Channels beyond CRDT: pty/exec/lsp frames are *routed*, not   │
│  interpreted — relay bridges them to NATS subjects             │
└────────────────────────────────────────────────────────────────┘
```

- **One goroutine per room** owns all room state (actor model). All conn reads funnel into the
  room inbox; all mutations happen on that goroutine. This removes locking bugs and makes
  per-room ordering trivial.
- Server holds a live Y.Doc per active room (via `yrs`, the Rust Yjs port, through cgo — or
  the y-crdt Go bindings). Holding real state (not blind relay) enables: SyncStep2 diffs for
  joiners without S3 reads, server-side validation, agent edits injected server-side, and
  authoritative snapshots.
- **Backpressure:** per-conn bounded send queue (slow reader → coalesce CRDT updates via
  `Y.mergeUpdates`, drop stale awareness, disconnect at hard cap). A slow tab must never stall
  the room goroutine.

## 5. Sync, presence, cursors

- Wire protocol = `y-protocols/sync`: **SyncStep1** (client sends state vector) →
  **SyncStep2** (server sends missing update diff) → steady-state incremental updates both
  directions. Idempotent, order-tolerant, resumable — reconnect is just re-running it.
- **Awareness protocol** (separate channel, *not* persisted in the doc): per-client entry
  `{user, color, cursor: {fileId, anchor, head}, status, isAgent, agentTaskId?}` with 30s TTL
  and heartbeats. Cursor positions encoded as **Yjs RelativePositions** (survive concurrent
  edits without transformation) and resolved to absolute positions client-side per frame.
- Awareness updates are throttled client-side (max 20/s per client) and delta-encoded;
  agents' awareness comes from conductor via the same protocol — presence parity is free.

## 6. Batching, delta compression, ordering

- **Client → relay:** Yjs update batching at 30 ms flush (or 64 updates); updates within a
  flush window are merged via `mergeUpdates` (lossless — CRDT updates compose).
- **Relay → peers:** per-tick (16 ms) coalescing per connection.
- **Relay → JetStream:** appender batches 100 ms windows into one `SessionEvent` frame batch
  (protobuf, zstd) — persistence never adds latency to the peer echo path (fanout first,
  persist async; durability window analyzed in §9).
- **Ordering:** within a room, room-goroutine order is authoritative and stamped with
  `(roomEpoch, seq)` + HLC timestamp for cross-stream timeline merge (doc 12 §2). CRDT
  correctness doesn't need this ordering — replay and terminals do.

## 7. Collaborative terminal synchronization

Terminals are **not CRDTs** — a PTY is an ordered byte stream with one authoritative producer.

- Output: warden coalesces PTY output (8–16 ms), stamps `(streamId, seq)`, publishes to
  `exec.{wsId}.stdout`; relay fans out to room. Clients detect seq gaps → request replay range.
- Input: any client with `terminal.write` capability sends input frames; warden serializes by
  arrival; **driver lock** (advisory, awareness-backed) prevents interleaved typing chaos:
  UI shows who's driving, others' input is queued-with-prompt or dropped per room policy.
- Resize events are last-writer-wins with the driver preferred.
- Scrollback replay for late joiners: last N KB from warden ring buffer; full history from
  timeline segments.

## 8. Offline reconciliation & edge cases

- Standard path: reconnect → SyncStep1/2 both directions → converged. Yjs handles arbitrary
  divergence *mechanically*; the *product* questions are policy:
- **Long-offline guard:** if offline > 72h or update diff > 5 MB, don't silently merge —
  stage the offline version as a named branch-like "offline draft" and present a diff UI.
  Mechanical merges of week-old work produce semantically wrong code even when CRDT-correct.
- **Identical-position concurrent inserts** interleave per YATA (deterministic but
  occasionally surprising) — mitigated by awareness (you see the other cursor) and by agents
  editing via whole-range replacements per hunk rather than char streams.
- **Tombstone growth:** long-lived docs GC'd continuously (Yjs GC on), full re-snapshot
  compaction when snapshot > 4× live text size.
- **Clock skew:** HLC everywhere; never trust client wall clocks — client events are stamped
  at relay ingress.

## 9. Persistence, snapshots, recovery

- **Persistence model:** JetStream `SESSION` stream = short-horizon durable log (48 h);
  **snapshotter** writes full encoded doc state (`Y.encodeStateAsUpdate`, zstd) to S3 every
  5 min of activity or 10k updates, keyed `snap/{wsId}/{docId}/{updateClock}`; **compactor**
  rolls JetStream ranges into immutable S3 segments for the timeline (doc 12).
- **Room load:** latest snapshot + JetStream tail replay (bounded by snapshot cadence → ≤5 min
  of updates → typically <50 ms apply time).
- **Durability window:** fanout-then-persist means a relay crash can lose the last ≤100 ms
  batch *from the server log* — but every connected client still holds those updates and
  re-syncs them to the failover relay via state vectors. True loss requires simultaneous
  relay crash + all-client loss within the window. Documented and accepted; paranoid mode
  (persist-before-echo) exists as a per-org flag with a latency cost.
- **Failover:** relay heartbeats its room set into the Redis directory (TTL 10 s). On node
  death: router reassigns rooms on next client (re)connect via rendezvous hash over live
  nodes; new relay loads snapshot+tail; clients re-sync. Target: < 5 s to restored
  interactivity, zero acknowledged-data loss.

## 10. Scaling & room partitioning

- **Rooms are single-homed** — one relay owns a room; no cross-node CRDT merging on the hot
  path. This is the load-bearing simplification: correctness stays local, scaling is
  placement. (Cross-node rooms via NATS-bridged relays exist as a Scale-phase design for
  >500-participant rooms; not built before needed.)
- **Placement:** rendezvous hashing (HRW) over healthy relays weighted by capacity score
  (conns, mem, CPU); router consults/updates Redis directory; sticky for room lifetime.
- **Bottleneck math:** dominant cost is fanout: `updates/sec × peers × frame size`. A
  50-person room at 30 combined updates/sec × ~120 B ≈ 180 KB/s egress — trivial. The real
  ceilings are (a) connection memory (~64 KB budget/conn incl. queues → 10k conns ≈ 640 MB),
  (b) room goroutine CPU at extreme update rates (agents doing bulk edits — mitigated by
  agents batching hunks), (c) JetStream publish throughput (batched, fine). Scale-out is
  horizontal relay count; nothing is shared between rooms.
- **Draining:** deploys mark relay draining → router stops placing → rooms migrate on natural
  reconnect or forced handoff (snapshot → directory repoint → client `RECONNECT` frame) →
  zero-downtime deploys of the collab plane.
