// Package room implements the collab-relay's core: one actor goroutine per
// room owning all room state (doc 04 §4). No locks on the hot path — every
// mutation flows through the room's inbox.
//
// v0 semantics (documented deltas from the blueprint's end state):
//   - The relay does not hold a live Y.Doc; it relays and persists opaque
//     Yjs updates. Late joiners replay the full log (correct because Yjs
//     updates are commutative and idempotent). Log growth is bounded by
//     client-driven compaction: the relay asks a client for a full-state
//     snapshot (FlagCompact) and atomically replaces the log.
//   - Rooms live until process shutdown (no idle unload; avoids unload/join
//     races that the production room-router handoff protocol solves).
package room

import (
	"log/slog"

	"atelier.dev/services/collab-relay/store"
	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/yaware"
)

const (
	// Compaction triggers: whichever comes first.
	compactMaxEntries = 200
	compactMaxBytes   = 1 << 20 // 1 MiB
	// Replay batching: frames are concatenated up to this size per WS message.
	replayBatchBytes = 256 << 10
)

type awState struct {
	clock uint64
	json  string
	owner *Client
}

type inboundFrame struct {
	c *Client
	f wire.Frame
}

type joinMsg struct{ c *Client }
type leaveMsg struct{ c *Client }

// Room is a single collaborative session (one workspace, v0: one doc).
type Room struct {
	Name  string
	store store.Store
	log   *slog.Logger

	inbox   chan any
	clients map[*Client]struct{}

	// CRDT update log (opaque Yjs updates, oldest first).
	updates  [][]byte
	logBytes int

	// Compaction state: when a compact_request is outstanding, compactMark is
	// the log length at request time and compactBy the client asked.
	compactBy   *Client
	compactMark int

	// Awareness: yjs clientID → latest state, with the owning connection so
	// the room can synthesize removals on disconnect.
	aware map[uint64]awState

	// The workspace host (PTY/exec provider) for this room, if connected.
	// PTY frames route client↔host; the relay never interprets them.
	host *Client
}

func newRoom(name string, st store.Store, logger *slog.Logger) (*Room, error) {
	updates, err := st.Load(name)
	if err != nil {
		return nil, err
	}
	bytes := 0
	for _, u := range updates {
		bytes += len(u)
	}
	r := &Room{
		Name:     name,
		store:    st,
		log:      logger.With("room", name),
		inbox:    make(chan any, 256),
		clients:  make(map[*Client]struct{}),
		updates:  updates,
		logBytes: bytes,
		aware:    make(map[uint64]awState),
	}
	go r.run()
	return r, nil
}

// Join hands a connected client to the room actor.
func (r *Room) Join(c *Client) { r.inbox <- joinMsg{c} }

func (r *Room) leave(c *Client) { r.inbox <- leaveMsg{c} }

func (r *Room) submit(c *Client, f wire.Frame) { r.inbox <- inboundFrame{c, f} }

func (r *Room) run() {
	for msg := range r.inbox {
		switch m := msg.(type) {
		case joinMsg:
			r.handleJoin(m.c)
		case leaveMsg:
			r.handleLeave(m.c)
		case inboundFrame:
			r.handleFrame(m.c, m.f)
		}
	}
}

// ── join / leave ─────────────────────────────────────────────────────────

func (r *Room) handleJoin(c *Client) {
	if c.Role == wire.RoleHost {
		// Latest host wins (a restarted workspace-host reconnects while the
		// old TCP session may still linger).
		if r.host != nil {
			r.log.Warn("replacing existing host", "old", r.host.ID, "new", c.ID)
			r.handleLeave(r.host)
		}
		r.host = c
	}

	r.clients[c] = struct{}{}
	c.trySend(ctrlWelcome(c.ID, r.Name, len(r.updates)))

	// Replay the CRDT log in batched messages so a large log doesn't flood
	// the client's send queue with thousands of tiny frames.
	batch := make([]byte, 0, replayBatchBytes)
	for _, u := range r.updates {
		fr := wire.Encode(wire.Frame{Channel: wire.ChCRDT, Payload: u})
		if len(batch) > 0 && len(batch)+len(fr) > replayBatchBytes {
			c.trySend(batch)
			batch = make([]byte, 0, replayBatchBytes)
		}
		batch = append(batch, fr...)
	}
	if len(batch) > 0 {
		c.trySend(batch)
	}

	// Current presence for the late joiner.
	if len(r.aware) > 0 {
		entries := make([]yaware.Entry, 0, len(r.aware))
		for id, st := range r.aware {
			entries = append(entries, yaware.Entry{ClientID: id, Clock: st.clock, StateJSON: st.json})
		}
		c.trySend(wire.Encode(wire.Frame{Channel: wire.ChAware, Payload: yaware.Encode(entries)}))
	}

	c.trySend(ctrlHostStatus(r.host != nil))
	c.trySend(ctrlSyncDone())
	r.broadcast(c, ctrlPeerJoined(c.ID, c.User))
	if c == r.host {
		r.broadcast(c, ctrlHostStatus(true))
	}
	r.log.Info("client joined", "client", c.ID, "user", c.User.Name, "role", c.Role, "peers", len(r.clients))
}

func (r *Room) handleLeave(c *Client) {
	if _, ok := r.clients[c]; !ok {
		return // duplicate leave (read error + shutdown, slow-kick + read error, …)
	}
	delete(r.clients, c)
	c.shutdown()

	// Synthesize awareness removals for yjs clients owned by this connection.
	var removals []yaware.Entry
	for id, st := range r.aware {
		if st.owner == c {
			removals = append(removals, yaware.Entry{ClientID: id, Clock: st.clock + 1, StateJSON: "null"})
			delete(r.aware, id)
		}
	}
	if len(removals) > 0 {
		r.broadcast(nil, wire.Encode(wire.Frame{Channel: wire.ChAware, Payload: yaware.Encode(removals)}))
	}
	r.broadcast(nil, ctrlPeerLeft(c.ID))
	if r.host == c {
		r.host = nil
		r.broadcast(nil, ctrlHostStatus(false))
	}

	// If a pending compaction was assigned to this client, retry via another.
	if r.compactBy == c {
		r.compactBy = nil
		r.maybeRequestCompaction(nil)
	}
	r.log.Info("client left", "client", c.ID, "peers", len(r.clients))
}

// ── frame handling ───────────────────────────────────────────────────────

func (r *Room) handleFrame(c *Client, f wire.Frame) {
	if _, ok := r.clients[c]; !ok {
		return // frame raced with leave
	}
	recordFrameIn(f.Channel, len(f.Payload))
	switch f.Channel {
	case wire.ChCRDT:
		r.handleCRDT(c, f)
	case wire.ChAware:
		r.handleAware(c, f)
	case wire.ChCtrl:
		r.handleCtrl(c, f)
	case wire.ChPty:
		r.handlePty(c, f)
	default:
		r.log.Debug("ignoring frame on unimplemented channel", "channel", f.Channel)
	}
}

func (r *Room) handleCRDT(c *Client, f wire.Frame) {
	payload := append([]byte(nil), f.Payload...) // decouple from read buffer

	if f.Flags&wire.FlagCompact != 0 {
		if c != r.compactBy {
			return // unsolicited or stale snapshot; ignore
		}
		// Snapshot covers everything the client had applied at request time
		// (log[:compactMark] — guaranteed by in-order delivery + synchronous
		// apply). Updates appended since remain as the tail.
		newLog := make([][]byte, 0, 1+len(r.updates)-r.compactMark)
		newLog = append(newLog, payload)
		newLog = append(newLog, r.updates[r.compactMark:]...)
		if err := r.store.Replace(r.Name, newLog); err != nil {
			r.log.Error("compaction persist failed; keeping old log", "err", err)
			r.compactBy = nil
			return
		}
		r.updates = newLog
		r.logBytes = 0
		for _, u := range newLog {
			r.logBytes += len(u)
		}
		r.compactBy = nil
		mCompactions.Add(bg, 1)
		r.log.Info("log compacted", "entries", len(newLog), "bytes", r.logBytes)
		return
	}

	r.updates = append(r.updates, payload)
	r.logBytes += len(payload)
	if err := r.store.Append(r.Name, payload); err != nil {
		r.log.Error("append failed", "err", err)
	}
	r.broadcast(c, wire.Encode(wire.Frame{Channel: wire.ChCRDT, StreamID: f.StreamID, Payload: payload}))
	r.maybeRequestCompaction(c)
}

func (r *Room) maybeRequestCompaction(preferred *Client) {
	if r.compactBy != nil {
		return
	}
	if len(r.updates) <= compactMaxEntries && r.logBytes <= compactMaxBytes {
		return
	}
	target := preferred
	if target == nil {
		for cl := range r.clients {
			target = cl
			break
		}
	}
	if target == nil {
		return // empty room; next joiner's traffic will re-trigger
	}
	r.compactBy = target
	r.compactMark = len(r.updates)
	target.trySend(ctrlCompactRequest())
}

func (r *Room) handleAware(c *Client, f wire.Frame) {
	entries, err := yaware.Parse(f.Payload)
	if err != nil {
		r.log.Warn("bad awareness update", "client", c.ID, "err", err)
		return
	}
	for _, e := range entries {
		prev, ok := r.aware[e.ClientID]
		if ok && e.Clock < prev.clock {
			continue // stale
		}
		if e.StateJSON == "null" {
			delete(r.aware, e.ClientID)
			continue
		}
		r.aware[e.ClientID] = awState{clock: e.Clock, json: e.StateJSON, owner: c}
	}
	payload := append([]byte(nil), f.Payload...)
	r.broadcast(c, wire.Encode(wire.Frame{Channel: wire.ChAware, Payload: payload}))
}

func (r *Room) handleCtrl(c *Client, f wire.Frame) {
	var msg ClientCtrl
	if err := unmarshalCtrl(f.Payload, &msg); err != nil {
		r.log.Warn("bad ctrl message", "client", c.ID, "err", err)
		return
	}
	switch msg.Type {
	case "ping":
		c.trySend(ctrlPong(msg.T))
	case "pty_open", "pty_resize", "pty_close":
		// Terminal lifecycle requests route to the host, uninterpreted.
		if c != r.host && r.host != nil {
			payload := append([]byte(nil), f.Payload...)
			r.host.trySend(wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: payload}))
		}
	case "pty_exit":
		// Host announces a terminal's death to everyone else.
		if c == r.host {
			payload := append([]byte(nil), f.Payload...)
			r.broadcast(c, wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: payload}))
		}
	default:
		r.log.Debug("unhandled ctrl", "type", msg.Type)
	}
}

// handlePty routes terminal bytes without interpreting them: client input
// goes to the host; host output fans out to every participant (shared
// terminals per doc 04 §7 — the PTY is server-authoritative, not a CRDT).
func (r *Room) handlePty(c *Client, f wire.Frame) {
	payload := append([]byte(nil), f.Payload...) // decouple from read buffer
	frame := wire.Encode(wire.Frame{Channel: wire.ChPty, StreamID: f.StreamID, Payload: payload})
	if c == r.host {
		r.broadcast(c, frame)
		return
	}
	if r.host != nil {
		r.host.trySend(frame)
	}
}

// broadcast sends buf to every client except skip. Slow clients (full send
// queue) are kicked rather than allowed to stall the room; the kick runs the
// full leave path (awareness removal, peer_left) after iteration completes.
func (r *Room) broadcast(skip *Client, buf []byte) {
	var slow []*Client
	sent := 0
	for cl := range r.clients {
		if cl == skip {
			continue
		}
		if cl.trySend(buf) {
			sent++
		} else {
			slow = append(slow, cl)
		}
	}
	if sent > 0 {
		mBroadcasts.Add(bg, int64(sent))
	}
	for _, cl := range slow {
		if _, ok := r.clients[cl]; ok {
			r.log.Warn("kicking slow client", "client", cl.ID)
			mSlowKicks.Add(bg, 1)
			r.handleLeave(cl)
		}
	}
}
