package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Schema bootstrap is idempotent DDL for v0; real migrations (atlas,
// expand→migrate→contract) arrive with the first breaking change
// (blueprint doc 13 §3).
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  color      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id             text PRIMARY KEY,
  slug           text UNIQUE NOT NULL,
  name           text NOT NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_last_opened ON workspaces (last_opened_at DESC);
`

type PGStore struct {
	pool *pgxpool.Pool
}

func NewPGStore(ctx context.Context, databaseURL string) (*PGStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: bootstrap schema: %w", err)
	}
	return &PGStore{pool: pool}, nil
}

func (s *PGStore) EnsureUser(ctx context.Context, u User) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO users (id, name, color) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
		u.ID, u.Name, u.Color)
	return err
}

func (s *PGStore) TouchWorkspace(ctx context.Context, slug, createdBy string) (Workspace, error) {
	var ws Workspace
	err := s.pool.QueryRow(ctx, `
		INSERT INTO workspaces (id, slug, name, created_by)
		VALUES ($1, $2, $2, $3)
		ON CONFLICT (slug) DO UPDATE SET last_opened_at = now()
		RETURNING id, slug, name, COALESCE(created_by, ''), created_at, last_opened_at`,
		"ws_"+randomHex(8), slug, createdBy).
		Scan(&ws.ID, &ws.Slug, &ws.Name, &ws.CreatedBy, &ws.CreatedAt, &ws.LastOpenedAt)
	return ws, err
}

func (s *PGStore) ListWorkspaces(ctx context.Context, limit int) ([]Workspace, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, slug, name, COALESCE(created_by, ''), created_at, last_opened_at
		FROM workspaces ORDER BY last_opened_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Workspace
	for rows.Next() {
		var ws Workspace
		if err := rows.Scan(&ws.ID, &ws.Slug, &ws.Name, &ws.CreatedBy, &ws.CreatedAt, &ws.LastOpenedAt); err != nil {
			return nil, err
		}
		out = append(out, ws)
	}
	return out, rows.Err()
}

func (s *PGStore) Close() { s.pool.Close() }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("store: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
