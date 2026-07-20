// preview-router: turns a workspace's running dev server into a shareable URL
// (blueprint doc 05 §7). Workspaces register {room, port} → target; the router
// reverse-proxies http://{port}--{room}.preview.<domain> (and a /_p/{room}/{port}/
// path fallback) to the backend, streaming WebSocket/SSE.
//
// Dev-open by default: no register secret, previews public. Set
// PREVIEW_REGISTER_SECRET to authenticate registrations and PREVIEW_SHARE_SECRET
// to make previews private (share-token gated).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"atelier.dev/services/preview-router/router"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	addr := envOr("PREVIEW_ADDR", ":8790")
	domain := envOr("PREVIEW_DOMAIN", "preview.localhost")
	ttl := envDuration("PREVIEW_TTL", 20*time.Second)

	opts := router.Options{
		Domain:         domain,
		PublicPort:     publicPort(addr),
		PathHost:       envOr("PREVIEW_PATH_HOST", "localhost"),
		RegisterSecret: os.Getenv("PREVIEW_REGISTER_SECRET"),
	}
	if secret := os.Getenv("PREVIEW_SHARE_SECRET"); secret != "" {
		opts.ShareSecret = []byte(secret)
		logger.Info("preview share-token auth enforced (private previews)")
	}

	reg := router.NewRegistry(ttl)
	srv := router.New(reg, opts, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Sweep expired routes so crashed dev servers self-heal.
	go func() {
		t := time.NewTicker(ttl / 2)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if n := reg.Sweep(); n > 0 {
					logger.Debug("swept expired previews", "count", n)
				}
			}
		}
	}()

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	logger.Info("preview-router listening", "addr", addr, "domain", domain, "ttl", ttl)
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

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

// publicPort extracts the port browsers reach the router on from the bind addr.
func publicPort(addr string) int {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 8790
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		return 8790
	}
	return n
}
