// Package integration wires real components together: an in-process relay,
// a real workspace-host (spawning real shells), and a protocol-level client.
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/room"
	"atelier.dev/services/collab-relay/server"
	"atelier.dev/services/collab-relay/store"
	"atelier.dev/services/workspace-host/host"
)

const timeout = 15 * time.Second

type client struct {
	t     *testing.T
	conn  *websocket.Conn
	queue []wire.Frame
}

func dial(t *testing.T, wsBase, roomName string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsBase+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.SetReadLimit(wire.MaxPayload + 1024)
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	c := &client{t: t, conn: conn}
	hello, _ := json.Marshal(wire.CtrlMsg{
		Type: "hello", V: 1, Room: roomName,
		User: &wire.UserInfo{ID: "it-user", Name: "it-user", Color: "#00ff00"},
	})
	c.send(wire.Frame{Channel: wire.ChCtrl, Payload: hello})
	return c
}

func (c *client) send(f wire.Frame) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageBinary, wire.Encode(f)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) sendCtrl(msg wire.CtrlMsg) {
	payload, _ := json.Marshal(msg)
	c.send(wire.Frame{Channel: wire.ChCtrl, Payload: payload})
}

func (c *client) next() wire.Frame {
	c.t.Helper()
	if len(c.queue) > 0 {
		f := c.queue[0]
		c.queue = c.queue[1:]
		return f
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	frames, err := wire.DecodeAll(data)
	if err != nil {
		c.t.Fatalf("decode: %v", err)
	}
	for i := range frames {
		frames[i].Payload = append([]byte(nil), frames[i].Payload...)
	}
	c.queue = frames[1:]
	return frames[0]
}

func (c *client) waitHostOnline() {
	c.t.Helper()
	for i := 0; i < 1000; i++ {
		f := c.next()
		if f.Channel != wire.ChCtrl {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(f.Payload, &m)
		if m["type"] == "host_status" && m["online"] == true {
			return
		}
	}
	c.t.Fatal("host never came online")
}

// collectPtyUntil accumulates PTY output until it contains marker.
func (c *client) collectPtyUntil(marker string) {
	c.t.Helper()
	var out bytes.Buffer
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		f := c.next()
		if f.Channel == wire.ChPty {
			out.Write(f.Payload)
			if bytes.Contains(out.Bytes(), []byte(marker)) {
				return
			}
		}
	}
	c.t.Fatalf("marker %q never seen in pty output; got: %q", marker, out.String())
}

func TestRealShellThroughFullStack(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelWarn}))
	srv := server.New(room.NewManager(store.NewMemStore(), "", logger), logger, server.Options{})
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	// Real workspace-host with a real /bin/sh.
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = host.Run(ctx, host.Config{
			RelayURL: wsBase, Room: "it", Dir: t.TempDir(), Shell: "/bin/sh",
			Name: "workspace", Logger: logger,
		})
	}()

	c := dial(t, wsBase, "it")
	c.waitHostOnline()

	// Open a terminal and run a command whose output is unambiguous: the
	// echoed input contains "RES_%s", only execution produces "RES_OK".
	c.sendCtrl(wire.CtrlMsg{Type: "pty_open", StreamID: 1, Cols: 100, Rows: 30})
	c.send(wire.Frame{Channel: wire.ChPty, StreamID: 1, Payload: []byte("printf 'RES_%s\\n' OK\r")})
	c.collectPtyUntil("RES_OK")

	// Close: the shell dies and the host announces pty_exit.
	c.sendCtrl(wire.CtrlMsg{Type: "pty_close", StreamID: 1})
	for i := 0; i < 1000; i++ {
		f := c.next()
		if f.Channel != wire.ChCtrl {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(f.Payload, &m)
		if m["type"] == "pty_exit" && m["streamId"] == float64(1) {
			return
		}
	}
	t.Fatal("never saw pty_exit")
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}
