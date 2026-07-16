// Package store persists per-room CRDT update logs.
//
// v0 backends: in-memory (tests) and filesystem (dev/single-node). The
// interface is shaped so a JetStream+S3 backend (blueprint doc 04 §9) can
// slot in without touching room logic.
package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sync"
)

// Store persists ordered CRDT update logs, one per room.
type Store interface {
	// Load returns the full update log for a room, oldest first.
	// A missing room returns an empty log, not an error.
	Load(room string) ([][]byte, error)
	// Append adds one update to the room's log.
	Append(room string, update []byte) error
	// Replace atomically swaps the room's entire log (compaction).
	Replace(room string, log [][]byte) error
}

// ── In-memory (tests) ────────────────────────────────────────────────────

type MemStore struct {
	mu   sync.Mutex
	logs map[string][][]byte
}

func NewMemStore() *MemStore {
	return &MemStore{logs: make(map[string][][]byte)}
}

func (m *MemStore) Load(room string) ([][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.logs[room]
	out := make([][]byte, len(src))
	for i, u := range src {
		out[i] = append([]byte(nil), u...)
	}
	return out, nil
}

func (m *MemStore) Append(room string, update []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logs[room] = append(m.logs[room], append([]byte(nil), update...))
	return nil
}

func (m *MemStore) Replace(room string, log [][]byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([][]byte, len(log))
	for i, u := range log {
		cp[i] = append([]byte(nil), u...)
	}
	m.logs[room] = cp
	return nil
}

// ── Filesystem ───────────────────────────────────────────────────────────

// FSStore keeps one append-only log file per room:
// records of [u32 big-endian length][bytes]. Replace writes a temp file and
// renames it into place (atomic on POSIX).
type FSStore struct {
	dir string
	mu  sync.Mutex // coarse; fine for single-node v0
}

func NewFSStore(dir string) (*FSStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir %s: %w", dir, err)
	}
	return &FSStore{dir: dir}, nil
}

func (s *FSStore) path(room string) string {
	return filepath.Join(s.dir, url.PathEscape(room)+".ylog")
}

func (s *FSStore) Load(room string) ([][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path(room))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var log [][]byte
	for off := 0; off < len(data); {
		if len(data)-off < 4 {
			return nil, fmt.Errorf("store: truncated record header in %s", room)
		}
		n := int(binary.BigEndian.Uint32(data[off : off+4]))
		off += 4
		if len(data)-off < n {
			return nil, fmt.Errorf("store: truncated record body in %s", room)
		}
		log = append(log, append([]byte(nil), data[off:off+n]...))
		off += n
	}
	return log, nil
}

func (s *FSStore) Append(room string, update []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(s.path(room), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	return writeRecord(f, update)
}

func (s *FSStore) Replace(room string, log [][]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := s.path(room) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	for _, u := range log {
		if err := writeRecord(f, u); err != nil {
			f.Close()
			os.Remove(tmp)
			return err
		}
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, s.path(room))
}

func writeRecord(w io.Writer, update []byte) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(update)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(update)
	return err
}
