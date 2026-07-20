package preview

import (
	"context"
	"log/slog"
	"strconv"
	"time"
)

// Registrar publishes preview routes to the preview-router. The seam lets the
// watcher be tested without a network.
type Registrar interface {
	Register(port int, target, name string) error
	Unregister(port int) error
}

// Watcher polls the workspace's listening ports and keeps the preview-router in
// sync: newly-opened ports are registered (and re-registered each tick as a
// heartbeat so the router's TTL keeps them alive), closed ports are removed.
type Watcher struct {
	Lister     PortLister
	Reg        Registrar
	RootPIDs   func() []int // live workspace shell PIDs
	TargetHost string       // host the router dials, e.g. "127.0.0.1"
	Interval   time.Duration
	Log        *slog.Logger

	known map[int]string // port → last-seen command name
}

// Run polls until ctx is cancelled, then unregisters everything it published so
// no stale previews linger after the workspace host exits.
func (w *Watcher) Run(ctx context.Context) {
	if w.Interval <= 0 {
		w.Interval = 3 * time.Second
	}
	if w.TargetHost == "" {
		w.TargetHost = "127.0.0.1"
	}
	w.known = make(map[int]string)

	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		w.tick()
		select {
		case <-ctx.Done():
			w.drain()
			return
		case <-t.C:
		}
	}
}

// tick reconciles one scan against what we've published.
func (w *Watcher) tick() {
	listeners, err := w.Lister.Listening(w.RootPIDs())
	if err != nil {
		w.logger().Debug("preview scan failed", "err", err)
		return
	}
	current := make(map[int]string, len(listeners))
	for _, l := range listeners {
		current[l.Port] = l.Cmd
		target := w.TargetHost + ":" + strconv.Itoa(l.Port)
		if err := w.Reg.Register(l.Port, target, l.Cmd); err != nil {
			w.logger().Debug("preview register failed", "port", l.Port, "err", err)
			continue
		}
		if _, existed := w.known[l.Port]; !existed {
			w.logger().Info("preview up", "port", l.Port, "cmd", l.Cmd)
		}
		w.known[l.Port] = l.Cmd
	}
	// Ports that vanished since last tick → remove.
	for port := range w.known {
		if _, still := current[port]; !still {
			if err := w.Reg.Unregister(port); err != nil {
				w.logger().Debug("preview unregister failed", "port", port, "err", err)
			}
			delete(w.known, port)
			w.logger().Info("preview down", "port", port)
		}
	}
}

func (w *Watcher) logger() *slog.Logger {
	if w.Log != nil {
		return w.Log
	}
	return slog.Default()
}

// drain unregisters everything on shutdown.
func (w *Watcher) drain() {
	for port := range w.known {
		_ = w.Reg.Unregister(port)
	}
}
