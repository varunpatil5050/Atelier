package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/store"
)

var (
	tokenSecret   = []byte("relay-test-secret-0123456789")
	serviceSecret = "svc-secret-for-tests"
)

func authServer(t *testing.T) *httptest.Server {
	return newTestServerOpts(t, store.NewMemStore(), Options{
		TokenSecret:   tokenSecret,
		ServiceSecret: serviceSecret,
	})
}

// dialRaw opens a socket and sends an arbitrary hello; returns the conn.
func dialRaw(t *testing.T, ts *httptest.Server, hello map[string]any) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	payload, _ := json.Marshal(hello)
	if err := conn.Write(ctx, websocket.MessageBinary, wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: payload})); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	return conn
}

func expectClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("expected connection to be closed")
	}
}

func expectWelcome(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("expected welcome, got close: %v", err)
	}
	frames, err := wire.DecodeAll(data)
	if err != nil || len(frames) == 0 {
		t.Fatalf("bad frame: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(frames[0].Payload, &m)
	if m["type"] != "welcome" {
		t.Fatalf("expected welcome, got %v", m)
	}
	return m
}

func mintToken(t *testing.T, room string, user wire.UserInfo, ttl time.Duration) string {
	t.Helper()
	tok, err := authtoken.Mint(tokenSecret, authtoken.Claims{
		Room: room, User: user,
		IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(ttl).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func baseHello(room string, extra map[string]any) map[string]any {
	h := map[string]any{
		"type": "hello", "v": 1, "room": room,
		"user": map[string]string{"id": "spoofed", "name": "spoofed", "color": "#000000"},
	}
	for k, v := range extra {
		h[k] = v
	}
	return h
}

func TestAuthRejectsTokenlessHello(t *testing.T) {
	ts := authServer(t)
	expectClosed(t, dialRaw(t, ts, baseHello("locked", nil)))
}

func TestAuthRejectsForgedAndExpiredTokens(t *testing.T) {
	ts := authServer(t)

	valid := mintToken(t, "locked", wire.UserInfo{ID: "u1", Name: "alice", Color: "#ff0000"}, time.Minute)
	forged := valid[:len(valid)-4] + "AAAA"
	expectClosed(t, dialRaw(t, ts, baseHello("locked", map[string]any{"token": forged})))

	expired := mintToken(t, "locked", wire.UserInfo{ID: "u1", Name: "alice", Color: "#ff0000"}, -time.Second)
	expectClosed(t, dialRaw(t, ts, baseHello("locked", map[string]any{"token": expired})))
}

func TestAuthRejectsTokenForDifferentRoom(t *testing.T) {
	ts := authServer(t)
	tok := mintToken(t, "other-room", wire.UserInfo{ID: "u1", Name: "alice", Color: "#ff0000"}, time.Minute)
	expectClosed(t, dialRaw(t, ts, baseHello("locked", map[string]any{"token": tok})))
}

func TestAuthAcceptsValidTokenAndUsesTokenIdentity(t *testing.T) {
	ts := authServer(t)

	tokA := mintToken(t, "locked", wire.UserInfo{ID: "u1", Name: "alice", Color: "#ff0000"}, time.Minute)
	a := dialRaw(t, ts, baseHello("locked", map[string]any{"token": tokA}))
	expectWelcome(t, a)

	// b's hello asserts a spoofed identity; its token says "bob". a must see
	// bob's peer_joined carrying the token identity, never the spoofed one.
	tokB := mintToken(t, "locked", wire.UserInfo{ID: "u2", Name: "bob", Color: "#00ff00"}, time.Minute)
	b := dialRaw(t, ts, baseHello("locked", map[string]any{"token": tokB}))
	expectWelcome(t, b)

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	for i := 0; i < 50; i++ {
		_, data, err := a.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if strings.Contains(string(data), "spoofed") {
			t.Fatal("spoofed hello identity leaked into the room")
		}
		frames, _ := wire.DecodeAll(data)
		for _, f := range frames {
			if f.Channel != wire.ChCtrl {
				continue
			}
			var m map[string]any
			_ = json.Unmarshal(f.Payload, &m)
			if m["type"] == "peer_joined" {
				user, _ := m["user"].(map[string]any)
				if user["name"] != "bob" || user["id"] != "u2" {
					t.Fatalf("peer_joined identity = %v, want token identity", user)
				}
				return
			}
		}
	}
	t.Fatal("never observed peer_joined")
}

func TestAuthHostRequiresServiceSecret(t *testing.T) {
	ts := authServer(t)

	// Host with a valid *room token* must be rejected: hosts are
	// infrastructure and only authenticate via the service secret.
	tok := mintToken(t, "locked", wire.UserInfo{ID: "h", Name: "h", Color: "#000000"}, time.Minute)
	expectClosed(t, dialRaw(t, ts, baseHello("locked", map[string]any{"role": "host", "token": tok})))

	expectClosed(t, dialRaw(t, ts, baseHello("locked", map[string]any{"role": "host", "token": "wrong-secret"})))

	host := dialRaw(t, ts, baseHello("locked", map[string]any{"role": "host", "token": serviceSecret}))
	expectWelcome(t, host)
}

func TestAuthServiceSecretAllowsParticipantServices(t *testing.T) {
	ts := authServer(t)
	// doc-fs connects as a regular participant using the service secret.
	c := dialRaw(t, ts, baseHello("locked", map[string]any{"token": serviceSecret}))
	expectWelcome(t, c)
}
