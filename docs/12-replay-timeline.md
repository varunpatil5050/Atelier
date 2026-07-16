# 12 — Replayable Development Timeline (Blueprint §15)

The pitch: **"Git + multiplayer replay + AI trace visualization."** Scrub through a session
like a video: watch every keystroke, terminal line, execution, and agent decision — with the
agent's reasoning inspectable at every step. Because the whole platform is event-sourced,
this is a *storage format and a player*, not a parallel capture system.

---

## 1. What gets captured (already flowing — capture is subscription)

| Channel | Source | Event granularity |
|---|---|---|
| `crdt` | relay | Yjs update batches (100 ms windows) per subdoc |
| `pty` | warden | coalesced output frames + input frames (seq'd) |
| `exec` | warden | run lifecycle, exit codes, resource usage |
| `agent` | conductor | step/attempt events, model+tool call records, approvals |
| `presence` | relay | join/leave, cursor stream (downsampled to 10 Hz for storage) |
| `marks` | users | manual bookmarks ("bug reproduced here"), auto-marks (test flipped red→green) |

## 2. Ordering: hybrid logical clocks

Producers stamp every `EventEnvelope` with an HLC `(physicalMs, logical, nodeId)`:
- HLC merge rule on every message receipt keeps causality: if relay processed input A before
  output B arrived, B's HLC > A's.
- Cross-channel playback sorts by HLC within a bounded watermark (500 ms) — small
  cross-stream skew is invisible at playback; *within* a channel, per-subject seq is exact.
- Why not vector clocks: participant sets are large and dynamic; HLC gives near-causal
  ordering at O(1) size, and channels with hard ordering needs (pty, crdt) carry their own
  sequence numbers anyway.

## 3. Storage format

**timeline-compactor** consumes the SESSION/EXEC/AGENT streams and writes immutable
**segments** to S3 (5-min windows or 32 MB, whichever first):

```
segment file:
  header { sessionId, seq, hlcRange, channelDirectory[] }
  channel blocks (columnar-ish: frames of one channel stored contiguously):
    [varint len | EventEnvelope bytes]* → zstd (per-channel trained dictionary)
  footer { per-channel HLC→byteOffset sparse index (every 64 frames), crc }
manifest (Postgres `replay_segments` + a JSON manifest object in S3)
```

- Channel-contiguous layout lets the player fetch *only* the channels a view needs (the
  terminal-only embed doesn't download CRDT frames) via S3 range requests.
- Large payloads (artifacts, big diffs) stay artifact-referenced — segments hold refs.

## 4. Snapshots & seeking

- **Doc snapshots:** encoded Yjs state per subdoc every 5 min (already produced by the
  relay snapshotter — reused).
- **Terminal snapshots:** serialized xterm buffer state (grid + scrollback tail) every 5 min
  per stream.
- **Seek algorithm:** nearest snapshot ≤ t → apply CRDT updates (snapshot→t) [Yjs applies
  thousands of updates/ms] + replay pty frames into a headless terminal → paint. Worst case
  = full 5-min window ≈ hundreds of ms of apply time → **seek p95 ≤ 1.5 s** anywhere in an
  8-hour session, from cold S3.

## 5. Deterministic agent replay (two modes)

- **Visual replay** (every run): fold recorded events → render the exact step cards, tool
  I/O, diffs, approvals as they happened. No model calls. This is the audit/education view:
  *"show me why the agent changed the retry logic"* → scrub to the step, read the compiled
  context manifest and reasoning summary, see the failing test that motivated it.
- **Re-simulation** (engineering tool): re-execute conductor logic substituting recorded
  `model.result`/`tool.result` by `(stepId, attempt, seq)` — verifies orchestrator
  refactors change nothing (CI golden-run suite); with *live* model calls but recorded tool
  results, it becomes the prompt-regression harness (doc 13 §6).

## 6. Playback architecture

```
player client ── manifest fetch ──▶ core-api (authz: replay requires workspace read + org
                                     retention policy check)
              ── segment ranges ──▶ S3 (signed URLs, channel-selective)
   PlaybackEngine (web worker): decode → HLC-ordered frame heap → clock loop
      ├─▶ EditorHost in playback mode (applies CRDT updates to a local Y.Doc)
      ├─▶ xterm instances in playback mode
      ├─▶ agent panel in playback mode
      └─▶ presence ghosts (interpolated cursors)
   Controls: play/pause, 0.5×–16×, per-channel mute, jump-to-mark, "activity heatbar"
   (events/sec histogram under the scrubber — dense spots are where things happened)
```

- The player reuses the live components (doc 03 §5.7) — playback mode is an event-source
  swap, which is why this feature is cheap here and expensive everywhere else.
- **Branch-from-here:** any point in the timeline can fork a new workspace: rebuild doc
  state at t, restore nearest volume snapshot, open as a new session ("what if we'd taken
  the other approach at 14:32" — also the killer demo).

## 7. Privacy, retention, cost

Replay honors org policy: retention windows per plan, per-workspace opt-out, redaction jobs
(rewrite segments dropping a channel/time-range — immutability + manifests make this a
copy-and-repoint operation), viewer-role gating. Storage math: a heavy 8-h pairing session
≈ 40–80 MB compressed — cheap enough to default-on, which is exactly why it can be the
signature feature.
