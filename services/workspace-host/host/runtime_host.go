package host

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// HostRuntime runs shells directly on the machine (no isolation). This is the
// zero-dependency default for local dev.
type HostRuntime struct {
	shell string
	dir   string
}

func NewHostRuntime(shell, dir string) *HostRuntime {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	return &HostRuntime{shell: shell, dir: dir}
}

func (h *HostRuntime) Spawn(cols, rows uint16) (*Session, error) {
	cmd := exec.Command(h.shell)
	cmd.Dir = h.dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, err
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

func (h *HostRuntime) Close() error { return nil }
