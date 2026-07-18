// Package timeline records a replayable log of everything that happens in a
// room (blueprint doc 12): CRDT updates and presence changes, each stamped
// with a monotonic sequence and wall-clock time. A browser player fetches the
// log and scrubs through the session, rebuilding the document at any point.
//
// v0 deltas (documented in PROGRESS.md):
//   - Ordering is the room actor's single-threaded processing order (a total
//     order), not the blueprint's cross-relay HLC — correct for one relay.
//   - Storage is one JSONL file per room, not zstd-compressed S3 segments;
//     CRDT payloads are base64 in JSON. Fine at workspace scale; the segment
//     format + snapshots (doc 12 §3–4) slot behind the same Recorder/reader.
//   - Terminal (pty) and agent-reasoning channels are not captured yet; the
//     Kind field is the extension point.
package timeline

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Kind tags a timeline event's channel.
type Kind string

const (
	KindCRDT  Kind = "crdt"  // an opaque Yjs update (base64 in Data)
	KindJoin  Kind = "join"  // a participant joined
	KindLeave Kind = "leave" // a participant left
)

// User is the minimal identity carried on presence events (mirrors
// wire.UserInfo without importing it, keeping this package dependency-light).
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Event is one recorded moment. Data is base64-encoded raw bytes for CRDT
// events; User is set for join/leave.
type Event struct {
	Seq  uint64 `json:"seq"`
	TsMs int64  `json:"ts"`
	Kind Kind   `json:"kind"`
	Data string `json:"data,omitempty"`
	User *User  `json:"user,omitempty"`
}

// Recorder appends a room's timeline to a JSONL file. All methods are called
// from the room's single actor goroutine, so seq assignment needs no lock;
// the mutex only guards concurrent Close.
type Recorder struct {
	mu   sync.Mutex
	f    *os.File
	w    *bufio.Writer
	seq  uint64
	now  func() time.Time // injectable for tests
	path string
}

// NewRecorder opens (creating) the per-room timeline file for appending. A nil
// Recorder is valid and no-ops, so recording can be disabled centrally.
func NewRecorder(dir, room string) (*Recorder, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("timeline: mkdir: %w", err)
	}
	path := filepath.Join(dir, room+".jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("timeline: open %s: %w", path, err)
	}
	// Resume seq past whatever is already on disk so a reopened room's log
	// stays monotonic.
	seq, err := lastSeq(path)
	if err != nil {
		f.Close()
		return nil, err
	}
	return &Recorder{f: f, w: bufio.NewWriter(f), seq: seq, now: time.Now, path: path}, nil
}

// RecordCRDT logs a Yjs update. The payload is copied via base64 encoding, so
// the caller may reuse its buffer.
func (r *Recorder) RecordCRDT(update []byte) {
	if r == nil {
		return
	}
	r.write(Event{Kind: KindCRDT, Data: base64.StdEncoding.EncodeToString(update)})
}

func (r *Recorder) RecordJoin(u User)  { r.presence(KindJoin, u) }
func (r *Recorder) RecordLeave(u User) { r.presence(KindLeave, u) }

func (r *Recorder) presence(kind Kind, u User) {
	if r == nil {
		return
	}
	user := u
	r.write(Event{Kind: kind, User: &user})
}

func (r *Recorder) write(ev Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.w == nil {
		return // closed
	}
	r.seq++
	ev.Seq = r.seq
	ev.TsMs = r.now().UnixMilli()
	line, err := json.Marshal(ev)
	if err != nil {
		return // events are plain structs; marshal cannot fail at runtime
	}
	// Best-effort durability: buffered write + flush. Timeline loss on crash
	// is acceptable (it's a convenience log, not the source of truth).
	r.w.Write(line)
	r.w.WriteByte('\n')
	r.w.Flush()
}

// Close flushes and closes the file. Idempotent.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.w != nil {
		r.w.Flush()
		r.f.Close()
		r.w = nil
	}
}

func lastSeq(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return 0, nil
	}
	var max uint64
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var ev Event
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			break // stop at the first malformed/truncated tail line
		}
		if ev.Seq > max {
			max = ev.Seq
		}
	}
	return max, nil
}
