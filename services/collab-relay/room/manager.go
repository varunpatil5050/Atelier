package room

import (
	"log/slog"
	"sync"

	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/store"
	"atelier.dev/services/collab-relay/timeline"
)

// ValidRoomName reports whether name is an acceptable room identifier.
// (Defined at the protocol level so core-api validates identically.)
func ValidRoomName(name string) bool { return wire.ValidRoomName(name) }

// Manager owns the room registry. v0: rooms persist until process exit
// (see package comment in room.go for why there's no idle unload yet).
type Manager struct {
	mu          sync.Mutex
	rooms       map[string]*Room
	store       store.Store
	timelineDir string // "" disables replay recording
	log         *slog.Logger
}

// NewManager builds a manager. timelineDir "" disables timeline recording.
func NewManager(st store.Store, timelineDir string, logger *slog.Logger) *Manager {
	return &Manager{
		rooms:       make(map[string]*Room),
		store:       st,
		timelineDir: timelineDir,
		log:         logger,
	}
}

// Get returns the live room, loading its persisted log on first access.
func (m *Manager) Get(name string) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rooms[name]; ok {
		return r, nil
	}
	var rec *timeline.Recorder
	if m.timelineDir != "" {
		var err error
		if rec, err = timeline.NewRecorder(m.timelineDir, name); err != nil {
			m.log.Warn("timeline recorder init failed; recording disabled for room", "room", name, "err", err)
			rec = nil
		}
	}
	r, err := newRoom(name, m.store, rec, m.log)
	if err != nil {
		return nil, err
	}
	m.rooms[name] = r
	mRooms.Add(bg, 1)
	return r, nil
}

// TimelineDir returns the directory timelines are recorded to ("" if off).
func (m *Manager) TimelineDir() string { return m.timelineDir }

// Stats returns a small snapshot for /healthz-style introspection.
func (m *Manager) Stats() (rooms int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}
