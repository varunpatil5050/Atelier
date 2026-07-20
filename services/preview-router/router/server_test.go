package router

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/pkg/wire"
)

// newRouter spins up a preview-router over httptest and returns it with a helper
// to register a backend.
func newRouter(t *testing.T, opts Options) (*httptest.Server, *Registry) {
	t.Helper()
	reg := NewRegistry(time.Minute)
	ts := httptest.NewServer(New(reg, opts, nil))
	t.Cleanup(ts.Close)
	return ts, reg
}

// backendHostPort returns the host:port of an httptest backend.
func backendHostPort(t *testing.T, backend *httptest.Server) string {
	t.Helper()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

func TestProxyBySubdomain(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The app must see itself at root under subdomain routing.
		w.Header().Set("X-Seen-Path", r.URL.Path)
		_, _ = w.Write([]byte("hello from " + r.Host + r.URL.Path))
	}))
	defer backend.Close()

	ts, reg := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})
	reg.Upsert("demo", 3000, backendHostPort(t, backend), "vite")

	req, _ := http.NewRequest("GET", ts.URL+"/dashboard", nil)
	req.Host = "3000--demo.preview.localhost"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		t.Fatalf("status %d, body %q", res.StatusCode, body)
	}
	if got := res.Header.Get("X-Seen-Path"); got != "/dashboard" {
		t.Fatalf("backend saw path %q, want /dashboard (no rewrite under subdomain)", got)
	}
	if !strings.Contains(string(body), "hello from") {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestProxyByPathStripsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("path=" + r.URL.Path))
	}))
	defer backend.Close()

	ts, reg := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})
	reg.Upsert("demo", 3000, backendHostPort(t, backend), "")

	res, err := http.Get(ts.URL + "/_p/demo/3000/api/users")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if string(body) != "path=/api/users" {
		t.Fatalf("backend saw %q, want path=/api/users", body)
	}
}

func TestProxyUnregisteredIs502(t *testing.T) {
	ts, _ := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})
	req, _ := http.NewRequest("GET", ts.URL+"/", nil)
	req.Host = "9999--demo.preview.localhost"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", res.StatusCode)
	}
}

func TestControlEndpointsNotShadowedByProxy(t *testing.T) {
	// A request to the control host hits /v1/*, never the proxy — even for paths
	// a proxied app might also expose.
	ts, _ := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})
	res, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("healthz status %d", res.StatusCode)
	}
}

func TestRegisterThenList(t *testing.T) {
	ts, _ := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})

	body, _ := json.Marshal(registerReq{Room: "demo", Port: 5173, Target: "127.0.0.1:5173", Name: "vite"})
	res, err := http.Post(ts.URL+"/v1/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var reg struct{ URL, PathURL string }
	_ = json.NewDecoder(res.Body).Decode(&reg)
	res.Body.Close()
	if reg.URL != "http://5173--demo.preview.localhost:8790/" {
		t.Fatalf("register url = %q", reg.URL)
	}
	if reg.PathURL != "http://localhost:8790/_p/demo/5173/" {
		t.Fatalf("register pathUrl = %q", reg.PathURL)
	}

	res2, err := http.Get(ts.URL + "/v1/previews/demo")
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	var listed struct {
		Previews []previewView `json:"previews"`
	}
	_ = json.NewDecoder(res2.Body).Decode(&listed)
	if len(listed.Previews) != 1 || listed.Previews[0].Port != 5173 {
		t.Fatalf("list = %+v", listed.Previews)
	}
	// The internal target must never be exposed to the browser.
	raw, _ := json.Marshal(listed.Previews[0])
	if strings.Contains(string(raw), "target") || strings.Contains(string(raw), "127.0.0.1") {
		t.Fatalf("preview view leaked internal target: %s", raw)
	}
}

func TestRegisterSecretEnforced(t *testing.T) {
	ts, _ := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790, RegisterSecret: "s3cret"})
	body, _ := json.Marshal(registerReq{Room: "demo", Port: 3000, Target: "127.0.0.1:1"})

	res, _ := http.Post(ts.URL+"/v1/register", "application/json", bytes.NewReader(body))
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("unauthenticated register status %d, want 403", res.StatusCode)
	}
	res.Body.Close()

	req, _ := http.NewRequest("POST", ts.URL+"/v1/register", bytes.NewReader(body))
	req.Header.Set("X-Preview-Secret", "s3cret")
	req.Header.Set("Content-Type", "application/json")
	res2, _ := http.DefaultClient.Do(req)
	if res2.StatusCode != 200 {
		t.Fatalf("authenticated register status %d, want 200", res2.StatusCode)
	}
	res2.Body.Close()
}

func TestShareTokenGate(t *testing.T) {
	secret := []byte("preview-share-secret-32-bytes-xx")
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("private page"))
	}))
	defer backend.Close()

	ts, reg := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790, ShareSecret: secret})
	reg.Upsert("demo", 3000, backendHostPort(t, backend), "")

	// No token → 401.
	req, _ := http.NewRequest("GET", ts.URL+"/", nil)
	req.Host = "3000--demo.preview.localhost"
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-token status %d, want 401", res.StatusCode)
	}
	res.Body.Close()

	// Valid room-scoped token → 200.
	tok, err := authtoken.Mint(secret, authtoken.Claims{
		Room: "demo", User: wire.UserInfo{ID: "u1", Name: "sharer"},
		Role: "preview", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	req2, _ := http.NewRequest("GET", ts.URL+"/?__atelier_preview="+tok, nil)
	req2.Host = "3000--demo.preview.localhost"
	res2, _ := http.DefaultClient.Do(req2)
	if res2.StatusCode != 200 {
		t.Fatalf("valid-token status %d, want 200", res2.StatusCode)
	}
	res2.Body.Close()

	// Token scoped to a different room → 401.
	otherTok, _ := authtoken.Mint(secret, authtoken.Claims{
		Room: "elsewhere", User: wire.UserInfo{ID: "u1", Name: "sharer"},
		Role: "preview", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})
	req3, _ := http.NewRequest("GET", ts.URL+"/?__atelier_preview="+otherTok, nil)
	req3.Host = "3000--demo.preview.localhost"
	res3, _ := http.DefaultClient.Do(req3)
	if res3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong-room-token status %d, want 401", res3.StatusCode)
	}
	res3.Body.Close()
}

// TestProxyWebSocket proves the router forwards a WebSocket upgrade end to end —
// the property that makes previews work for live-reload dev servers.
func TestProxyWebSocket(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		_, msg, err := c.Read(r.Context())
		if err != nil {
			return
		}
		_ = c.Write(r.Context(), websocket.MessageText, append([]byte("echo:"), msg...))
	}))
	defer backend.Close()

	ts, reg := newRouter(t, Options{Domain: "preview.localhost", PublicPort: 8790})
	reg.Upsert("demo", 3000, backendHostPort(t, backend), "")

	// Dial the router with the preview Host header; expect the upgrade to reach
	// the backend and echo back.
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/socket"
	c, _, err := websocket.Dial(t.Context(), wsURL, &websocket.DialOptions{
		Host: "3000--demo.preview.localhost",
	})
	if err != nil {
		t.Fatalf("dial through router: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	if err := c.Write(t.Context(), websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, got, err := c.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "echo:ping" {
		t.Fatalf("ws round-trip got %q, want echo:ping", got)
	}
}
