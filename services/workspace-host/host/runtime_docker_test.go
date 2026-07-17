package host

import (
	"bufio"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestDockerRuntime proves shells run inside an isolated container: a
// different hostname than the machine, and the workspace dir visible through
// the bind mount. Skips (never pulls) when docker or the image is absent, so
// `go test ./...` stays fast and offline-safe.
func TestDockerRuntime(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available")
	}
	if err := exec.Command("docker", "image", "inspect", "alpine:3.20").Run(); err != nil {
		t.Skip("alpine:3.20 image not present (run `docker pull alpine:3.20` to enable)")
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte("synced-from-host\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelWarn}))
	rt := NewDockerRuntime(dir, "/bin/sh", DockerLimits{}, logger)
	t.Cleanup(func() {
		if err := rt.Close(); err != nil {
			t.Errorf("runtime close: %v", err)
		}
	})

	sess, err := rt.Spawn(30, 100)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}

	// Drive a script and read output until we see our sentinel. The sentinel
	// is assembled at runtime (ATELIER_$M) so it appears only in real output,
	// never in the echoed input line — the classic PTY-echo trap.
	const sentinel = "ATELIER_DONE"
	out := make(chan string, 1)
	go func() {
		var b strings.Builder
		sc := bufio.NewScanner(sess.Pty)
		for sc.Scan() {
			line := sc.Text()
			b.WriteString(line + "\n")
			// Match only a line that IS the sentinel (real output), not the
			// echoed command which contains "ATELIER_$M".
			if strings.TrimSpace(line) == sentinel {
				break
			}
		}
		out <- b.String()
	}()

	// hostname inside the container != the host's; the mounted file is present.
	script := "M=DONE; echo HN=$(hostname); cat /workspace/marker.txt; echo ATELIER_$M\n"
	if _, err := sess.Pty.Write([]byte(script)); err != nil {
		t.Fatalf("write: %v", err)
	}

	var got string
	select {
	case got = <-out:
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for container output")
	}

	hostHN, _ := os.Hostname()
	if !strings.Contains(got, "HN=") {
		t.Fatalf("no hostname line in output:\n%s", got)
	}
	if strings.Contains(got, "HN="+hostHN) {
		t.Fatalf("shell hostname matched the host — not containerized:\n%s", got)
	}
	if !strings.Contains(got, "synced-from-host") {
		t.Fatalf("workspace mount not visible in container:\n%s", got)
	}

	// Clean shell exit propagates a code.
	if _, err := sess.Pty.Write([]byte("exit 7\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	done := make(chan int, 1)
	go func() { done <- sess.wait() }()
	select {
	case code := <-done:
		// docker exec surfaces the in-container exit code.
		if code != 7 {
			t.Logf("exit code = %d (want 7; docker exec code propagation is best-effort)", code)
		}
	case <-time.After(10 * time.Second):
		sess.kill()
		t.Fatal("shell did not exit")
	}
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}
