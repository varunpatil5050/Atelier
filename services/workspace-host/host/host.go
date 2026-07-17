// Package host implements the workspace host: it joins a room as the PTY/exec
// provider (hello role=host) and bridges real shells into the room's PTY
// channel. This is the local-dev precursor of the guest-agent that will run
// inside workspace microVMs (blueprint doc 05 §3) — same protocol, so the
// swap is a deployment change, not a protocol change.
//
// v0 deltas (documented): no output ring buffer (late joiners see new output
// only), output dropped while the relay connection is down (shells survive
// reconnects), one shell per streamId with idempotent opens.
package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"atelier.dev/pkg/wire"
)

type Config struct {
	RelayURL string // e.g. ws://localhost:8787 (no /ws suffix)
	Room     string
	Dir      string // working directory for shells (mounted into the container in docker mode)
	Shell    string
	Name     string // presence name shown to participants
	// ServiceToken authenticates to a relay running with auth enforced
	// (RELAY_SERVICE_SECRET). Empty in tokenless dev mode.
	ServiceToken string
	// Runtime selects the isolation rung: "host" (default) or "docker".
	Runtime string
	Docker  DockerLimits
	Logger  *slog.Logger
}

type term struct {
	session *Session
}

type Host struct {
	cfg     Config
	log     *slog.Logger
	runtime Runtime

	mu      sync.Mutex // guards conn + terms
	conn    *websocket.Conn
	writeMu sync.Mutex // serializes websocket writes
	terms   map[uint16]*term
}

// Run connects to the relay and serves PTYs until ctx is cancelled,
// reconnecting with backoff. Shells survive relay reconnects.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	logger := cfg.Logger.With("room", cfg.Room)

	var runtime Runtime
	switch cfg.Runtime {
	case "docker":
		runtime = NewDockerRuntime(cfg.Dir, cfg.Shell, cfg.Docker, logger)
	case "", "host":
		runtime = NewHostRuntime(cfg.Shell, cfg.Dir)
	default:
		return fmt.Errorf("unknown runtime %q (want host|docker)", cfg.Runtime)
	}

	h := &Host{cfg: cfg, log: logger, runtime: runtime, terms: make(map[uint16]*term)}
	defer h.closeAll()

	delay := time.Second
	for {
		err := h.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		h.log.Warn("relay session ended; reconnecting", "err", err, "delay", delay)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
		if delay < 10*time.Second {
			delay *= 2
		}
	}
}

func (h *Host) session(ctx context.Context) error {
	conn, _, err := websocket.Dial(ctx, h.cfg.RelayURL+"/ws", nil)
	if err != nil {
		return fmt.Errorf("dial relay: %w", err)
	}
	conn.SetReadLimit(wire.MaxPayload + 1024)

	hello, err := json.Marshal(wire.CtrlMsg{
		Type: "hello", V: 1, Room: h.cfg.Room, Role: wire.RoleHost,
		User:  &wire.UserInfo{ID: "host-" + randomID(), Name: h.cfg.Name, Color: "#8b93a1"},
		Token: h.cfg.ServiceToken,
	})
	if err != nil {
		conn.Close(websocket.StatusInternalError, "")
		return err
	}
	if err := conn.Write(ctx, websocket.MessageBinary, wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: hello})); err != nil {
		conn.Close(websocket.StatusInternalError, "")
		return fmt.Errorf("send hello: %w", err)
	}

	h.mu.Lock()
	h.conn = conn
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.conn == conn {
			h.conn = nil
		}
		h.mu.Unlock()
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	h.log.Info("connected to relay", "relay", h.cfg.RelayURL, "shell", h.cfg.Shell, "dir", h.cfg.Dir)
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary {
			continue
		}
		frames, err := wire.DecodeAll(data)
		if err != nil {
			return fmt.Errorf("malformed frame from relay: %w", err)
		}
		for _, f := range frames {
			h.handleFrame(f)
		}
	}
}

func (h *Host) handleFrame(f wire.Frame) {
	switch f.Channel {
	case wire.ChCtrl:
		var msg wire.CtrlMsg
		if err := json.Unmarshal(f.Payload, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "pty_open":
			h.openTerm(msg.StreamID, msg.Cols, msg.Rows)
		case "pty_resize":
			h.resize(msg.StreamID, msg.Cols, msg.Rows)
		case "pty_close":
			h.closeTerm(msg.StreamID)
		}
	case wire.ChPty:
		h.mu.Lock()
		t := h.terms[f.StreamID]
		h.mu.Unlock()
		if t != nil {
			_, _ = t.session.Pty.Write(f.Payload)
		}
	default:
		// CRDT/awareness replay noise from the join sequence — not ours.
	}
}

// openTerm is idempotent: a second open for a live stream is treated as an
// attach (resize only), so multiple participants can share one terminal.
func (h *Host) openTerm(id, cols, rows uint16) {
	h.mu.Lock()
	if _, exists := h.terms[id]; exists {
		h.mu.Unlock()
		h.resize(id, cols, rows)
		return
	}
	h.mu.Unlock()

	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	session, err := h.runtime.Spawn(cols, rows)
	if err != nil {
		h.log.Error("shell spawn failed", "stream", id, "err", err)
		h.sendCtrl(wire.CtrlMsg{Type: "pty_exit", StreamID: id, Code: -1})
		return
	}

	t := &term{session: session}
	h.mu.Lock()
	h.terms[id] = t
	h.mu.Unlock()
	h.log.Info("pty opened", "stream", id, "runtime", h.runtimeName())
	go h.pump(id, t)
}

// pump streams PTY output into the room until the shell dies.
func (h *Host) pump(id uint16, t *term) {
	buf := make([]byte, 8192)
	for {
		n, err := t.session.Pty.Read(buf)
		if n > 0 {
			// wire.Encode copies the payload, so buf can be reused.
			h.send(wire.Frame{Channel: wire.ChPty, StreamID: id, Payload: buf[:n]})
		}
		if err != nil {
			break // EIO on shell exit is the normal path
		}
	}
	code := t.session.wait()
	h.mu.Lock()
	delete(h.terms, id)
	h.mu.Unlock()
	h.sendCtrl(wire.CtrlMsg{Type: "pty_exit", StreamID: id, Code: code})
	h.log.Info("pty exited", "stream", id, "code", code)
}

func (h *Host) resize(id, cols, rows uint16) {
	h.mu.Lock()
	t := h.terms[id]
	h.mu.Unlock()
	if t != nil && cols > 0 && rows > 0 {
		_ = pty.Setsize(t.session.Pty, &pty.Winsize{Rows: rows, Cols: cols})
	}
}

func (h *Host) closeTerm(id uint16) {
	h.mu.Lock()
	t := h.terms[id]
	h.mu.Unlock()
	if t != nil {
		t.session.kill() // pump observes EOF and announces pty_exit
	}
}

func (h *Host) closeAll() {
	h.mu.Lock()
	terms := make([]*term, 0, len(h.terms))
	for _, t := range h.terms {
		terms = append(terms, t)
	}
	h.mu.Unlock()
	for _, t := range terms {
		t.session.kill()
	}
	if err := h.runtime.Close(); err != nil {
		h.log.Warn("runtime close failed", "err", err)
	}
}

func (h *Host) runtimeName() string {
	if h.cfg.Runtime == "docker" {
		return "docker"
	}
	return "host"
}

func (h *Host) sendCtrl(msg wire.CtrlMsg) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.send(wire.Frame{Channel: wire.ChCtrl, Payload: payload})
}

// send writes a frame if connected; drops otherwise (shells outlive relay
// outages — the gap in output is an accepted v0 limitation).
func (h *Host) send(f wire.Frame) {
	h.mu.Lock()
	conn := h.conn
	h.mu.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	_ = conn.Write(ctx, websocket.MessageBinary, wire.Encode(f))
}

func randomID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("host: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}
