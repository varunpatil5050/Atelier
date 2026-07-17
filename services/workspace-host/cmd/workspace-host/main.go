// workspace-host: bridges real shells into an Atelier room's terminal channel.
//
//	go run atelier.dev/services/workspace-host/cmd/workspace-host --room demo
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"atelier.dev/services/workspace-host/host"
)

func main() {
	room := flag.String("room", "", "room to serve (required)")
	relay := flag.String("relay", "ws://localhost:8787", "relay base URL")
	dir := flag.String("dir", ".", "working directory for shells")
	shell := flag.String("shell", "", "shell binary (default: $SHELL then /bin/sh; /bin/sh in docker mode)")
	name := flag.String("name", "workspace", "presence name")
	runtime := flag.String("runtime", "host", "execution runtime: host | docker")
	image := flag.String("image", "alpine:3.20", "container image (docker runtime)")
	memory := flag.String("memory", "512m", "memory limit (docker runtime)")
	cpus := flag.String("cpus", "1", "CPU limit (docker runtime)")
	pidsLimit := flag.String("pids-limit", "256", "process count limit (docker runtime)")
	network := flag.String("network", "none", "container network (docker runtime; 'none' = no egress)")
	flag.Parse()

	// Service token authenticates to an auth-enforced relay (falls back to env).
	serviceToken := os.Getenv("RELAY_SERVICE_SECRET")

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if *room == "" {
		logger.Error("--room is required")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := host.Run(ctx, host.Config{
		RelayURL: *relay, Room: *room, Dir: *dir, Shell: *shell, Name: *name,
		ServiceToken: serviceToken, Runtime: *runtime,
		Docker: host.DockerLimits{
			Image: *image, Memory: *memory, CPUs: *cpus,
			PidsLimit: *pidsLimit, Network: *network,
		},
		Logger: logger,
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("workspace-host failed", "err", err)
		os.Exit(1)
	}
}
