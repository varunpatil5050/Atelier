package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/services/core-api/store"
)

var (
	testSessionSecret = []byte("test-session-secret-000000000001")
	testRoomSecret    = []byte("test-room-secret-00000000000001")
)

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(discard{}, nil))
	srv := New(store.NewMemStore(), logger, Config{
		SessionSecret:   testSessionSecret,
		RoomTokenSecret: testRoomSecret,
	})
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func do(t *testing.T, method, url string, cookies []*http.Cookie) (*http.Response, map[string]any) {
	return doBody(t, method, url, cookies, "")
}

func doBody(t *testing.T, method, url string, cookies []*http.Cookie, body string) (*http.Response, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, url, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	var decoded map[string]any
	_ = json.NewDecoder(res.Body).Decode(&decoded)
	return res, decoded
}

func TestSessionMintAndReuse(t *testing.T) {
	ts := newServer(t)

	res, body := do(t, "POST", ts.URL+"/v1/session", nil)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	user1 := body["user"].(map[string]any)
	if user1["id"] == "" || user1["name"] == "" {
		t.Fatalf("bad user: %v", user1)
	}
	cookies := res.Cookies()
	if len(cookies) == 0 || cookies[0].Name != "atelier_session" {
		t.Fatal("no session cookie set")
	}

	// Same cookie → same identity, no new cookie.
	res2, body2 := do(t, "POST", ts.URL+"/v1/session", cookies)
	user2 := body2["user"].(map[string]any)
	if user2["id"] != user1["id"] {
		t.Fatalf("identity changed across requests: %v vs %v", user1, user2)
	}
	if len(res2.Cookies()) != 0 {
		t.Fatal("valid session should not re-mint a cookie")
	}
}

func TestRoomTokenRequiresSession(t *testing.T) {
	ts := newServer(t)
	res, _ := do(t, "POST", ts.URL+"/v1/rooms/demo/token", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", res.StatusCode)
	}
}

func TestRoomTokenMintsVerifiableClaims(t *testing.T) {
	ts := newServer(t)
	res, body := do(t, "POST", ts.URL+"/v1/session", nil)
	cookies := res.Cookies()
	user := body["user"].(map[string]any)

	res2, body2 := do(t, "POST", ts.URL+"/v1/rooms/demo/token", cookies)
	if res2.StatusCode != 200 {
		t.Fatalf("status %d: %v", res2.StatusCode, body2)
	}
	claims, err := authtoken.Verify(testRoomSecret, body2["token"].(string), time.Now())
	if err != nil {
		t.Fatalf("minted token does not verify: %v", err)
	}
	if claims.Room != "demo" || claims.User.ID != user["id"] {
		t.Fatalf("claims mismatch: %+v vs user %v", claims, user)
	}
	if claims.ExpiresAt-time.Now().Unix() > int64(RoomTokenTTL.Seconds())+5 {
		t.Fatal("token TTL too long")
	}

	// A session token must NOT pass as a room token (different secrets).
	if _, err := authtoken.Verify(testSessionSecret, body2["token"].(string), time.Now()); err == nil {
		t.Fatal("room token verified with session secret — secrets must differ per audience")
	}
}

func TestRoomTokenRejectsBadRoomNames(t *testing.T) {
	ts := newServer(t)
	res, _ := do(t, "POST", ts.URL+"/v1/session", nil)
	cookies := res.Cookies()
	res2, _ := do(t, "POST", ts.URL+"/v1/rooms/..%2Fetc/token", cookies)
	if res2.StatusCode == 200 {
		t.Fatal("accepted invalid room name")
	}
}

func TestWorkspaceListReflectsOpens(t *testing.T) {
	ts := newServer(t)
	res, _ := do(t, "POST", ts.URL+"/v1/session", nil)
	cookies := res.Cookies()

	do(t, "POST", ts.URL+"/v1/rooms/alpha/token", cookies)
	do(t, "POST", ts.URL+"/v1/rooms/beta/token", cookies)

	_, body := do(t, "GET", ts.URL+"/v1/workspaces", cookies)
	list := body["workspaces"].([]any)
	if len(list) != 2 {
		t.Fatalf("got %d workspaces, want 2", len(list))
	}
	first := list[0].(map[string]any)
	if first["slug"] != "beta" { // most recently opened first
		t.Fatalf("expected beta first, got %v", first["slug"])
	}
}

func TestCORSAllowsLocalOriginsWithCredentials(t *testing.T) {
	ts := newServer(t)
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/v1/session", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:3000" ||
		res.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("CORS headers missing: %v", res.Header)
	}

	req2, _ := http.NewRequest("OPTIONS", ts.URL+"/v1/session", nil)
	req2.Header.Set("Origin", "https://evil.example.com")
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS allowed a non-local origin")
	}
}
