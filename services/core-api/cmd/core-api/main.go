// core-api: Atelier's control plane (blueprint doc 09 §1) — v0 slice:
// dev sessions, workspaces, room-token minting.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"atelier.dev/pkg/obs"
	"atelier.dev/services/core-api/server"
	"atelier.dev/services/core-api/store"
)

// Dev-mode defaults keep `go run` zero-config; production must set env.
const (
	devSessionSecret = "dev-insecure-session-secret-0001"
	devRoomSecret    = "dev-insecure-room-token-secret-1"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	slog.SetDefault(logger)

	addr := envOr("CORE_ADDR", ":8788")
	sessionSecret := envOr("SESSION_SECRET", devSessionSecret)
	roomSecret := envOr("ROOM_TOKEN_SECRET", devRoomSecret)
	if sessionSecret == devSessionSecret || roomSecret == devRoomSecret {
		logger.Warn("using dev-insecure default secrets — set SESSION_SECRET / ROOM_TOKEN_SECRET in production")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var st store.Store
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		pg, err := store.NewPGStore(ctx, dbURL)
		if err != nil {
			logger.Error("postgres init failed", "err", err)
			os.Exit(1)
		}
		st = pg
		logger.Info("using postgres store")
	} else {
		st = store.NewMemStore()
		logger.Warn("DATABASE_URL not set — using in-memory store (dev only, data is ephemeral)")
	}
	defer st.Close()

	srv := server.New(st, logger, server.Config{
		SessionSecret:   []byte(sessionSecret),
		RoomTokenSecret: []byte(roomSecret),
	})
	if metricsHandler, err := obs.InitMetrics("core-api"); err != nil {
		logger.Warn("metrics init failed; continuing without /metrics", "err", err)
	} else {
		srv.SetMetricsHandler(metricsHandler)
	}

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	logger.Info("core-api listening", "addr", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server error", "err", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
