// collab-relay: Atelier's collaboration-plane node (blueprint doc 04).
// v0 scope: rooms, CRDT log relay + persistence, awareness, compaction.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"atelier.dev/pkg/obs"
	"atelier.dev/services/collab-relay/room"
	"atelier.dev/services/collab-relay/server"
	"atelier.dev/services/collab-relay/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	slog.SetDefault(logger)

	addr := envOr("RELAY_ADDR", ":8787")
	dataDir := envOr("RELAY_DATA_DIR", "./data/rooms")
	timelineDir := envOr("RELAY_TIMELINE_DIR", "./data/timeline")

	st, err := store.NewFSStore(dataDir)
	if err != nil {
		logger.Error("store init failed", "err", err)
		os.Exit(1)
	}
	mgr := room.NewManager(st, timelineDir, logger)
	opts := server.Options{
		ServiceSecret: os.Getenv("RELAY_SERVICE_SECRET"),
	}
	if origins := os.Getenv("RELAY_ORIGIN_PATTERNS"); origins != "" {
		opts.OriginPatterns = splitAndTrim(origins)
		logger.Info("ws origin allowlist", "patterns", opts.OriginPatterns)
	}
	if secret := os.Getenv("RELAY_TOKEN_SECRET"); secret != "" {
		opts.TokenSecret = []byte(secret)
		logger.Info("room-token auth enforced")
	}
	srv := server.New(mgr, logger, opts)
	if metricsHandler, err := obs.InitMetrics("collab-relay"); err != nil {
		logger.Warn("metrics init failed; continuing without /metrics", "err", err)
	} else {
		srv.SetMetricsHandler(metricsHandler)
	}

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv.SetBaseContext(ctx)

	go func() {
		<-ctx.Done()
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	logger.Info("collab-relay listening", "addr", addr, "dataDir", dataDir)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server error", "err", err)
		os.Exit(1)
	}
	fmt.Println("bye")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// splitAndTrim parses a comma-separated env value into trimmed, non-empty items.
func splitAndTrim(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
