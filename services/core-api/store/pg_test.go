package store

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"testing"
	"time"
)

// TestPGStore runs against a throwaway postgres container. It skips (rather
// than pulls) when docker or the image is unavailable, so `go test ./...`
// stays fast and offline-safe; CI and post-compose dev machines exercise it.
func TestPGStore(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available")
	}
	if err := exec.Command("docker", "image", "inspect", "postgres:16-alpine").Run(); err != nil {
		t.Skip("postgres:16-alpine image not present (run `docker compose pull` once to enable this test)")
	}

	port := freePort(t)
	name := fmt.Sprintf("atelier-pg-test-%d", time.Now().UnixNano())
	run := exec.Command("docker", "run", "--rm", "-d", "--name", name,
		"-e", "POSTGRES_PASSWORD=t", "-e", "POSTGRES_DB=t",
		"-p", fmt.Sprintf("%d:5432", port), "postgres:16-alpine")
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "stop", name).Run() })

	url := fmt.Sprintf("postgres://postgres:t@127.0.0.1:%d/t", port)
	ctx := context.Background()

	var st *PGStore
	deadline := time.Now().Add(60 * time.Second)
	for {
		var err error
		st, err = NewPGStore(ctx, url)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("postgres never became ready: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	defer st.Close()

	if err := st.EnsureUser(ctx, User{ID: "u1", Name: "alice", Color: "#f00"}); err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureUser(ctx, User{ID: "u1", Name: "alice2", Color: "#f00"}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	ws1, err := st.TouchWorkspace(ctx, "alpha", "u1")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := st.TouchWorkspace(ctx, "beta", "u1"); err != nil {
		t.Fatal(err)
	}
	ws1b, err := st.TouchWorkspace(ctx, "alpha", "u1") // reopen bumps recency
	if err != nil {
		t.Fatal(err)
	}
	if ws1b.ID != ws1.ID {
		t.Fatalf("touch created a duplicate workspace: %s vs %s", ws1b.ID, ws1.ID)
	}

	list, err := st.ListWorkspaces(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Slug != "alpha" {
		t.Fatalf("unexpected list order: %+v", list)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
