// Package store is core-api's system of record (blueprint doc 08).
// Postgres is the real backend; MemStore keeps `go run` zero-config for dev.
package store

import (
	"context"
	"sort"
	"sync"
	"time"
)

type User struct {
	ID    string
	Name  string
	Color string
}

type Workspace struct {
	ID           string
	Slug         string // doubles as the room name (v0)
	Name         string
	CreatedBy    string
	CreatedAt    time.Time
	LastOpenedAt time.Time
}

type Store interface {
	// EnsureUser upserts the user row.
	EnsureUser(ctx context.Context, u User) error
	// TouchWorkspace upserts a workspace by slug and bumps last_opened_at.
	TouchWorkspace(ctx context.Context, slug, createdBy string) (Workspace, error)
	// ListWorkspaces returns workspaces by recency of last open.
	ListWorkspaces(ctx context.Context, limit int) ([]Workspace, error)
	Close()
}

// ── in-memory (dev fallback + handler tests) ─────────────────────────────

type MemStore struct {
	mu         sync.Mutex
	users      map[string]User
	workspaces map[string]Workspace // by slug
}

func NewMemStore() *MemStore {
	return &MemStore{users: map[string]User{}, workspaces: map[string]Workspace{}}
}

func (m *MemStore) EnsureUser(_ context.Context, u User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.users[u.ID] = u
	return nil
}

func (m *MemStore) TouchWorkspace(_ context.Context, slug, createdBy string) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, ok := m.workspaces[slug]
	if !ok {
		ws = Workspace{
			ID: "ws_" + slug, Slug: slug, Name: slug,
			CreatedBy: createdBy, CreatedAt: time.Now(),
		}
	}
	ws.LastOpenedAt = time.Now()
	m.workspaces[slug] = ws
	return ws, nil
}

func (m *MemStore) ListWorkspaces(_ context.Context, limit int) ([]Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Workspace, 0, len(m.workspaces))
	for _, ws := range m.workspaces {
		out = append(out, ws)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastOpenedAt.After(out[j].LastOpenedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *MemStore) Close() {}
