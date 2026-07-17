package host

import (
	"errors"
	"os"
	"os/exec"
)

// Session is one running shell with its PTY master. wait blocks until the
// shell exits and returns its code; kill force-terminates it.
type Session struct {
	Pty  *os.File
	wait func() int
	kill func()
}

// Runtime spawns shells for a workspace. Implementations sit on a rung of the
// isolation ladder (blueprint doc 05): HostRuntime runs shells directly on the
// dev machine; DockerRuntime runs them inside a per-workspace container. The
// microVM guest agent is the production end state — same Runtime seam.
//
// Close tears down shared resources (e.g. the container); it runs once when
// the host shuts down.
type Runtime interface {
	Spawn(cols, rows uint16) (*Session, error)
	Close() error
}

// exitCode extracts a process exit code from cmd.Wait()'s error.
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}
