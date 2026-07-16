package server

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"atelier.dev/pkg/obs"
	"atelier.dev/services/core-api/store"
)

// OTel's global-instrument delegation is one-shot: the package-level
// instruments bind to the first installed provider and never re-bind. So
// metrics init happens exactly once here — mirroring production, where
// InitMetrics runs once per process — and the /metrics handler is shared.
var (
	metricsOnce    sync.Once
	sharedMetricsH http.Handler
	metricsInitErr error
)

func metricsServer(t *testing.T) *httptest.Server {
	t.Helper()
	metricsOnce.Do(func() {
		sharedMetricsH, metricsInitErr = obs.InitMetrics("core-api-test")
	})
	if metricsInitErr != nil {
		t.Fatal(metricsInitErr)
	}
	srv := New(store.NewMemStore(), slog.New(slog.NewTextHandler(discard{}, nil)), Config{
		SessionSecret: testSessionSecret, RoomTokenSecret: testRoomSecret,
	})
	srv.SetMetricsHandler(sharedMetricsH)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

func TestHTTPDurationMetricRecorded(t *testing.T) {
	ts := metricsServer(t)

	// Generate traffic across two routes.
	do(t, "POST", ts.URL+"/v1/session", nil)
	do(t, "GET", ts.URL+"/v1/workspaces", nil) // 401, still recorded

	res, err := http.Get(ts.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(res.Body)
	body := buf.String()

	if !strings.Contains(body, "http_server_duration_ms") {
		t.Fatalf("http duration metric missing from /metrics")
	}
	if !strings.Contains(body, `route="POST /v1/session"`) {
		t.Fatalf("expected session route label; got:\n%s", firstLines(body, 40))
	}
}

func TestRumEndpoint(t *testing.T) {
	ts := metricsServer(t)

	// Unauthenticated → rejected.
	res, _ := doBody(t, "POST", ts.URL+"/v1/rum", nil, `{"kind":"ws_rtt","ms":42}`)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("rum without session = %d, want 401", res.StatusCode)
	}

	sess, _ := do(t, "POST", ts.URL+"/v1/session", nil)
	cookies := sess.Cookies()

	// Valid sample accepted.
	res2, _ := doBody(t, "POST", ts.URL+"/v1/rum", cookies, `{"kind":"ws_rtt","ms":42.5}`)
	if res2.StatusCode != http.StatusAccepted {
		t.Fatalf("valid rum = %d, want 202", res2.StatusCode)
	}

	// Out-of-range and unknown-kind rejected.
	res3, _ := doBody(t, "POST", ts.URL+"/v1/rum", cookies, `{"kind":"ws_rtt","ms":999999}`)
	if res3.StatusCode != http.StatusBadRequest {
		t.Fatalf("out-of-range rum = %d, want 400", res3.StatusCode)
	}
	res4, _ := doBody(t, "POST", ts.URL+"/v1/rum", cookies, `{"kind":"evil","ms":1}`)
	if res4.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown-kind rum = %d, want 400", res4.StatusCode)
	}

	// The series shows up in /metrics.
	m, err := http.Get(ts.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(m.Body)
	if !strings.Contains(buf.String(), "rum_ws_rtt_ms") {
		t.Fatal("rum_ws_rtt_ms series missing")
	}
}

func firstLines(s string, n int) string {
	lines := strings.SplitN(s, "\n", n+1)
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}
