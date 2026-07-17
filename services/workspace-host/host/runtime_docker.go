package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// DockerLimits maps to blueprint doc 05 §7/§9 — per-workspace resource caps
// and network posture. Empty fields fall back to conservative defaults.
type DockerLimits struct {
	Image     string // container image (default: alpine:3.20)
	Memory    string // --memory (default: 512m)
	CPUs      string // --cpus (default: 1)
	PidsLimit string // --pids-limit (default: 256)
	Network   string // --network (default: none — no egress)
}

func (l DockerLimits) withDefaults() DockerLimits {
	if l.Image == "" {
		l.Image = "alpine:3.20"
	}
	if l.Memory == "" {
		l.Memory = "512m"
	}
	if l.CPUs == "" {
		l.CPUs = "1"
	}
	if l.PidsLimit == "" {
		l.PidsLimit = "256"
	}
	if l.Network == "" {
		l.Network = "none"
	}
	return l
}

// DockerRuntime runs a workspace's shells inside one long-lived container:
// filesystem scoped to the mounted workspace dir, memory/CPU/pids capped, and
// (by default) no network. Each terminal is a `docker exec` into that
// container, PTY-wrapped so resize and interactivity work.
type DockerRuntime struct {
	dir    string
	shell  string
	limits DockerLimits
	log    *slog.Logger

	name string

	mu      sync.Mutex
	started bool
}

func NewDockerRuntime(dir, shell string, limits DockerLimits, logger *slog.Logger) *DockerRuntime {
	if shell == "" {
		shell = "/bin/sh" // host $SHELL (e.g. /bin/zsh) won't exist in the image
	}
	return &DockerRuntime{
		dir:    dir,
		shell:  shell,
		limits: limits.withDefaults(),
		name:   "atelier-ws-" + randomName(),
		log:    logger,
	}
}

// ensure lazily starts the container (mutex-held by caller).
func (d *DockerRuntime) ensure() error {
	if d.started {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	args := []string{
		"run", "-d", "--name", d.name,
		"--memory", d.limits.Memory,
		"--cpus", d.limits.CPUs,
		"--pids-limit", d.limits.PidsLimit,
		"--network", d.limits.Network,
		"-w", "/workspace",
		"-v", d.dir + ":/workspace",
		d.limits.Image,
		// Keep PID 1 alive so we can exec into it; `sleep infinity` works in
		// both alpine (busybox) and node images.
		"sleep", "infinity",
	}
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %v: %s", err, strings.TrimSpace(string(out)))
	}
	d.started = true
	d.log.Info("workspace container started",
		"name", d.name, "image", d.limits.Image,
		"memory", d.limits.Memory, "cpus", d.limits.CPUs,
		"pids", d.limits.PidsLimit, "network", d.limits.Network)
	return nil
}

func (d *DockerRuntime) Spawn(cols, rows uint16) (*Session, error) {
	d.mu.Lock()
	err := d.ensure()
	d.mu.Unlock()
	if err != nil {
		return nil, err
	}

	// -i -t: interactive TTY inside the container; the docker client forwards
	// our PTY (including SIGWINCH resizes) to the exec'd shell.
	cmd := exec.Command("docker", "exec", "-i", "-t", "-w", "/workspace", d.name, d.shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, fmt.Errorf("docker exec: %w", err)
	}
	return &Session{
		Pty:  ptmx,
		wait: func() int { return exitCode(cmd.Wait()) },
		kill: func() {
			_ = ptmx.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		},
	}, nil
}

func (d *DockerRuntime) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.started {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "docker", "rm", "-f", d.name).CombinedOutput(); err != nil {
		return fmt.Errorf("docker rm: %v: %s", err, strings.TrimSpace(string(out)))
	}
	d.started = false
	d.log.Info("workspace container removed", "name", d.name)
	return nil
}

func randomName() string {
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("host: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}
