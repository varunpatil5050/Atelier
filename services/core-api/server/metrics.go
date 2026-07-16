package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

var (
	meter = otel.Meter("core-api")

	mHTTPDur, _ = meter.Float64Histogram("http_server_duration_ms",
		metric.WithDescription("request duration by route/status"))
	// The flagship RUM series (blueprint doc 10 §2): browser-measured
	// websocket round-trip time, the transport floor under keystroke echo.
	mRumWsRtt, _ = meter.Float64Histogram("rum_ws_rtt_ms",
		metric.WithDescription("client-reported websocket RTT"))
)

var bg = context.Background()

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// metricsMiddleware records a duration histogram per matched route pattern.
func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		route := r.Pattern // matched ServeMux pattern; empty for 404s
		if route == "" {
			route = "unmatched"
		}
		mHTTPDur.Record(bg, float64(time.Since(start).Microseconds())/1000.0,
			metric.WithAttributes(
				attribute.String("route", route),
				attribute.Int("status", rec.status),
			))
	})
}

// handleRum ingests browser-side measurements. Session-gated and clamped:
// RUM endpoints are abuse targets by construction.
func (s *Server) handleRum(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.sessionUser(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no session"})
		return
	}
	var sample struct {
		Kind string  `json:"kind"`
		Ms   float64 `json:"ms"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&sample); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad sample"})
		return
	}
	if sample.Kind != "ws_rtt" || sample.Ms < 0 || sample.Ms > 60_000 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown kind or out-of-range value"})
		return
	}
	mRumWsRtt.Record(bg, sample.Ms)
	w.WriteHeader(http.StatusAccepted)
}
