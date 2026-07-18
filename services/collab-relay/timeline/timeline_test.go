package timeline

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readEvents(t *testing.T, path string) []Event {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []Event
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var ev Event
		if err := dec.Decode(&ev); err != nil {
			break
		}
		out = append(out, ev)
	}
	return out
}

func TestRecordsOrderedEventsWithMonotonicSeq(t *testing.T) {
	dir := t.TempDir()
	rec, err := NewRecorder(dir, "room1")
	if err != nil {
		t.Fatal(err)
	}
	rec.RecordJoin(User{ID: "u1", Name: "alice", Color: "#f00"})
	rec.RecordCRDT([]byte{0x01, 0x02})
	rec.RecordCRDT([]byte{0x03})
	rec.RecordLeave(User{ID: "u1", Name: "alice", Color: "#f00"})
	rec.Close()

	events := readEvents(t, filepath.Join(dir, "room1.jsonl"))
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4", len(events))
	}
	for i, ev := range events {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("event %d has seq %d, want %d", i, ev.Seq, i+1)
		}
		if ev.TsMs == 0 {
			t.Fatalf("event %d has no timestamp", i)
		}
	}
	if events[0].Kind != KindJoin || events[0].User == nil || events[0].User.Name != "alice" {
		t.Fatalf("first event = %+v", events[0])
	}
	if events[1].Kind != KindCRDT {
		t.Fatalf("second event kind = %s", events[1].Kind)
	}
	// CRDT payload roundtrips through base64.
	got, _ := base64.StdEncoding.DecodeString(events[1].Data)
	if !bytes.Equal(got, []byte{0x01, 0x02}) {
		t.Fatalf("crdt payload = %x", got)
	}
	if events[3].Kind != KindLeave {
		t.Fatalf("last event kind = %s", events[3].Kind)
	}
}

func TestSeqResumesAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	rec, _ := NewRecorder(dir, "resume")
	rec.RecordCRDT([]byte{1})
	rec.RecordCRDT([]byte{2})
	rec.Close()

	rec2, err := NewRecorder(dir, "resume")
	if err != nil {
		t.Fatal(err)
	}
	rec2.RecordCRDT([]byte{3})
	rec2.Close()

	events := readEvents(t, filepath.Join(dir, "resume.jsonl"))
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	// Seq stays monotonic across the reopen (1,2,3), not restarting at 1.
	for i, ev := range events {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("event %d seq = %d, want %d", i, ev.Seq, i+1)
		}
	}
}

func TestNilRecorderIsNoOp(t *testing.T) {
	var rec *Recorder
	// None of these should panic.
	rec.RecordCRDT([]byte{1})
	rec.RecordJoin(User{ID: "x"})
	rec.RecordLeave(User{ID: "x"})
	rec.Close()
}
