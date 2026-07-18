package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"atelier.dev/services/collab-relay/room"
	"atelier.dev/services/collab-relay/store"
	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/yaware"
)

const testTimeout = 5 * time.Second

func newTestServer(t *testing.T, st store.Store) *httptest.Server {
	return newTestServerOpts(t, st, Options{})
}

func newTestServerOpts(t *testing.T, st store.Store, opts Options) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError}))
	srv := New(room.NewManager(st, t.TempDir(), logger), logger, opts)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

// ── test client ──────────────────────────────────────────────────────────

type testClient struct {
	t     *testing.T
	conn  *websocket.Conn
	queue []wire.Frame
}

func dial(t *testing.T, ts *httptest.Server, roomName, userName string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.SetReadLimit(wire.MaxPayload + 1024)
	c := &testClient{t: t, conn: conn}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })

	hello, _ := json.Marshal(map[string]any{
		"type": "hello", "v": 1, "room": roomName,
		"user": map[string]string{"id": userName, "name": userName, "color": "#ff0000"},
	})
	c.sendFrame(wire.Frame{Channel: wire.ChCtrl, Payload: hello})
	return c
}

func (c *testClient) sendFrame(f wire.Frame) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageBinary, wire.Encode(f)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) sendUpdate(payload []byte)   { c.sendFrame(wire.Frame{Channel: wire.ChCRDT, Payload: payload}) }
func (c *testClient) sendAware(entries []yaware.Entry) {
	c.sendFrame(wire.Frame{Channel: wire.ChAware, Payload: yaware.Encode(entries)})
}

// next returns the next frame, reading (and un-batching) as needed.
func (c *testClient) next() wire.Frame {
	c.t.Helper()
	if len(c.queue) > 0 {
		f := c.queue[0]
		c.queue = c.queue[1:]
		return f
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	typ, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		c.t.Fatalf("unexpected message type %v", typ)
	}
	frames, err := wire.DecodeAll(data)
	if err != nil {
		c.t.Fatalf("decode: %v", err)
	}
	for i := range frames { // decouple payloads from the read buffer
		frames[i].Payload = append([]byte(nil), frames[i].Payload...)
	}
	c.queue = frames[1:]
	return frames[0]
}

func (c *testClient) ctrlType(f wire.Frame) (string, map[string]any) {
	c.t.Helper()
	var m map[string]any
	if err := json.Unmarshal(f.Payload, &m); err != nil {
		c.t.Fatalf("ctrl json: %v", err)
	}
	typ, _ := m["type"].(string)
	return typ, m
}

// waitCtrl reads until a CTRL message of the given type, discarding others.
func (c *testClient) waitCtrl(want string) map[string]any {
	c.t.Helper()
	for i := 0; i < 1000; i++ {
		f := c.next()
		if f.Channel != wire.ChCtrl {
			continue
		}
		if typ, m := c.ctrlType(f); typ == want {
			return m
		}
	}
	c.t.Fatalf("never saw ctrl %q", want)
	return nil
}

// waitChannel reads until a frame on the given channel, discarding others.
func (c *testClient) waitChannel(ch byte) wire.Frame {
	c.t.Helper()
	for i := 0; i < 1000; i++ {
		f := c.next()
		if f.Channel == ch {
			return f
		}
	}
	c.t.Fatalf("never saw channel %d", ch)
	return wire.Frame{}
}

type syncResult struct {
	welcome map[string]any
	crdt    [][]byte
	aware   [][]byte
}

// readSync consumes the join sequence: welcome → replay → sync_done.
func (c *testClient) readSync() syncResult {
	c.t.Helper()
	res := syncResult{welcome: c.waitCtrl("welcome")}
	for {
		f := c.next()
		switch f.Channel {
		case wire.ChCRDT:
			res.crdt = append(res.crdt, f.Payload)
		case wire.ChAware:
			res.aware = append(res.aware, f.Payload)
		case wire.ChCtrl:
			if typ, _ := c.ctrlType(f); typ == "sync_done" {
				return res
			}
		}
	}
}

// barrier round-trips a ping so all frames sent before it are known-processed
// by the room actor (same connection + same inbox ⇒ ordered).
func (c *testClient) barrier() {
	c.t.Helper()
	c.sendFrame(wire.Frame{Channel: wire.ChCtrl, Payload: []byte(`{"type":"ping","t":1}`)})
	c.waitCtrl("pong")
}

// ── tests ────────────────────────────────────────────────────────────────

func TestRelayBroadcastAndReplay(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	a := dial(t, ts, "basic", "alice")
	syncA := a.readSync()
	if got := syncA.welcome["logLen"].(float64); got != 0 {
		t.Fatalf("fresh room logLen = %v", got)
	}
	if len(syncA.crdt) != 0 {
		t.Fatalf("fresh room replayed %d updates", len(syncA.crdt))
	}

	a.sendUpdate([]byte{0xAA, 0xBB})
	a.barrier()

	b := dial(t, ts, "basic", "bob")
	syncB := b.readSync()
	if len(syncB.crdt) != 1 || string(syncB.crdt[0]) != string([]byte{0xAA, 0xBB}) {
		t.Fatalf("late joiner replay = %x", syncB.crdt)
	}

	b.sendUpdate([]byte{0xCC})
	got := a.waitChannel(wire.ChCRDT)
	if string(got.Payload) != string([]byte{0xCC}) {
		t.Fatalf("broadcast payload = %x", got.Payload)
	}
}

func TestAwarenessRelayReplayAndDisconnectRemoval(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	a := dial(t, ts, "aw", "alice")
	a.readSync()
	b := dial(t, ts, "aw", "bob")
	b.readSync()

	a.sendAware([]yaware.Entry{{ClientID: 42, Clock: 1, StateJSON: `{"n":"a"}`}})

	f := b.waitChannel(wire.ChAware)
	entries, err := yaware.Parse(f.Payload)
	if err != nil || len(entries) != 1 || entries[0].ClientID != 42 {
		t.Fatalf("aware relay = %+v, %v", entries, err)
	}

	// Late joiner receives current presence.
	a.barrier()
	c := dial(t, ts, "aw", "cara")
	syncC := c.readSync()
	if len(syncC.aware) != 1 {
		t.Fatalf("late joiner got %d aware frames", len(syncC.aware))
	}
	entries, _ = yaware.Parse(syncC.aware[0])
	if len(entries) != 1 || entries[0].ClientID != 42 || entries[0].Clock != 1 {
		t.Fatalf("late joiner presence = %+v", entries)
	}

	// Disconnect synthesizes a removal with a bumped clock.
	a.conn.Close(websocket.StatusNormalClosure, "")
	for i := 0; i < 10; i++ {
		f = b.waitChannel(wire.ChAware)
		entries, _ = yaware.Parse(f.Payload)
		if len(entries) == 1 && entries[0].ClientID == 42 && entries[0].StateJSON == "null" {
			if entries[0].Clock != 2 {
				t.Fatalf("removal clock = %d, want 2", entries[0].Clock)
			}
			return
		}
	}
	t.Fatal("never saw awareness removal")
}

func TestCompaction(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	a := dial(t, ts, "compact", "alice")
	a.readSync()
	for i := 0; i <= 200; i++ { // 201 updates > compactMaxEntries
		a.sendUpdate([]byte(fmt.Sprintf("u%03d", i)))
	}
	a.waitCtrl("compact_request")
	a.sendFrame(wire.Frame{Channel: wire.ChCRDT, Flags: wire.FlagCompact, Payload: []byte("SNAPSHOT")})
	a.barrier()

	b := dial(t, ts, "compact", "bob")
	syncB := b.readSync()
	if got := syncB.welcome["logLen"].(float64); got != 1 {
		t.Fatalf("post-compaction logLen = %v", got)
	}
	if len(syncB.crdt) != 1 || string(syncB.crdt[0]) != "SNAPSHOT" {
		t.Fatalf("post-compaction replay = %q", syncB.crdt)
	}
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()

	st1, _ := store.NewFSStore(dir)
	ts1 := newTestServer(t, st1)
	a := dial(t, ts1, "durable", "alice")
	a.readSync()
	a.sendUpdate([]byte("first"))
	a.sendUpdate([]byte("second"))
	a.barrier()
	a.conn.Close(websocket.StatusNormalClosure, "")
	ts1.Close()

	// "Restarted" relay: fresh manager, same data dir.
	st2, _ := store.NewFSStore(dir)
	ts2 := newTestServer(t, st2)
	b := dial(t, ts2, "durable", "bob")
	syncB := b.readSync()
	if len(syncB.crdt) != 2 || string(syncB.crdt[0]) != "first" || string(syncB.crdt[1]) != "second" {
		t.Fatalf("post-restart replay = %q", syncB.crdt)
	}
}

func TestRejectsBadHello(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Invalid room name must close the connection.
	hello, _ := json.Marshal(map[string]any{
		"type": "hello", "v": 1, "room": "../etc/passwd",
		"user": map[string]string{"id": "x", "name": "x", "color": ""},
	})
	if err := conn.Write(ctx, websocket.MessageBinary, wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: hello})); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("expected close after invalid hello")
	}
}

func dialRole(t *testing.T, ts *httptest.Server, roomName, userName, role string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.SetReadLimit(wire.MaxPayload + 1024)
	c := &testClient{t: t, conn: conn}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })

	hello, _ := json.Marshal(map[string]any{
		"type": "hello", "v": 1, "room": roomName, "role": role,
		"user": map[string]string{"id": userName, "name": userName, "color": "#ff0000"},
	})
	c.sendFrame(wire.Frame{Channel: wire.ChCtrl, Payload: hello})
	return c
}

func TestPtyRoutingBetweenClientAndHost(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	host := dialRole(t, ts, "pty", "workspace", "host")
	host.readSync()

	a := dial(t, ts, "pty", "alice")
	if m := a.waitCtrl("host_status"); m["online"] != true {
		t.Fatalf("joiner host_status = %v, want online", m)
	}
	a.waitCtrl("sync_done")
	b := dial(t, ts, "pty", "bob")
	b.readSync()

	// Terminal open request routes to the host only.
	openMsg, _ := json.Marshal(map[string]any{"type": "pty_open", "streamId": 3, "cols": 80, "rows": 24})
	a.sendFrame(wire.Frame{Channel: wire.ChCtrl, Payload: openMsg})
	if m := host.waitCtrl("pty_open"); m["streamId"] != float64(3) || m["cols"] != float64(80) {
		t.Fatalf("host pty_open = %v", m)
	}

	// Client input → host.
	a.sendFrame(wire.Frame{Channel: wire.ChPty, StreamID: 3, Payload: []byte("ls\r")})
	if f := host.waitChannel(wire.ChPty); f.StreamID != 3 || string(f.Payload) != "ls\r" {
		t.Fatalf("host got %d %q", f.StreamID, f.Payload)
	}

	// Host output → all participants.
	host.sendFrame(wire.Frame{Channel: wire.ChPty, StreamID: 3, Payload: []byte("main.ts\r\n")})
	if f := a.waitChannel(wire.ChPty); string(f.Payload) != "main.ts\r\n" {
		t.Fatalf("a got %q", f.Payload)
	}
	if f := b.waitChannel(wire.ChPty); string(f.Payload) != "main.ts\r\n" {
		t.Fatalf("b got %q", f.Payload)
	}

	// Host-announced exit fans out.
	exitMsg, _ := json.Marshal(map[string]any{"type": "pty_exit", "streamId": 3, "code": 0})
	host.sendFrame(wire.Frame{Channel: wire.ChCtrl, Payload: exitMsg})
	if m := a.waitCtrl("pty_exit"); m["streamId"] != float64(3) {
		t.Fatalf("a pty_exit = %v", m)
	}

	// Host death → host_status offline for everyone.
	host.conn.Close(websocket.StatusNormalClosure, "")
	if m := a.waitCtrl("host_status"); m["online"] != false {
		t.Fatalf("a host_status after host death = %v", m)
	}
}

func TestTimelineEndpoint(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	// Record a session: a client joins and sends two updates.
	a := dial(t, ts, "tlroom", "alice")
	a.readSync()
	a.sendUpdate([]byte{0xAA})
	a.sendUpdate([]byte{0xBB})
	a.barrier()

	res, err := http.Get(ts.URL + "/timeline/tlroom")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var buf strings.Builder
	dec := json.NewDecoder(res.Body)
	kinds := []string{}
	for {
		var ev map[string]any
		if err := dec.Decode(&ev); err != nil {
			break
		}
		kinds = append(kinds, ev["kind"].(string))
		buf.WriteString(ev["kind"].(string) + " ")
	}
	// At least: join, crdt, crdt.
	if len(kinds) < 3 {
		t.Fatalf("expected >=3 events, got %v", kinds)
	}
	if kinds[0] != "join" {
		t.Fatalf("first event = %s, want join", kinds[0])
	}
	crdtCount := 0
	for _, k := range kinds {
		if k == "crdt" {
			crdtCount++
		}
	}
	if crdtCount != 2 {
		t.Fatalf("got %d crdt events, want 2 (%v)", crdtCount, kinds)
	}
}

func TestTimelineEndpointRejectsBadRoomAnd404s(t *testing.T) {
	ts := newTestServer(t, store.NewMemStore())

	res, _ := http.Get(ts.URL + "/timeline/..%2Fetc")
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad room name status = %d, want 400", res.StatusCode)
	}
	res.Body.Close()

	res2, _ := http.Get(ts.URL + "/timeline/never-opened")
	if res2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown room status = %d, want 404", res2.StatusCode)
	}
	res2.Body.Close()
}
