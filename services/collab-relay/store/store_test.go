package store

import (
	"bytes"
	"testing"
)

func testStore(t *testing.T, s Store) {
	t.Helper()

	// Missing room → empty log.
	log, err := s.Load("empty")
	if err != nil || len(log) != 0 {
		t.Fatalf("Load(missing) = %v, %v", log, err)
	}

	// Append preserves order and content.
	updates := [][]byte{[]byte("one"), {0, 1, 2, 255}, {}, []byte("four")}
	for _, u := range updates {
		if err := s.Append("r1", u); err != nil {
			t.Fatal(err)
		}
	}
	log, err = s.Load("r1")
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != len(updates) {
		t.Fatalf("got %d records, want %d", len(log), len(updates))
	}
	for i := range updates {
		if !bytes.Equal(log[i], updates[i]) {
			t.Fatalf("record %d = %x, want %x", i, log[i], updates[i])
		}
	}

	// Replace swaps atomically.
	if err := s.Replace("r1", [][]byte{[]byte("snapshot"), []byte("tail")}); err != nil {
		t.Fatal(err)
	}
	log, _ = s.Load("r1")
	if len(log) != 2 || string(log[0]) != "snapshot" || string(log[1]) != "tail" {
		t.Fatalf("after replace: %q", log)
	}

	// Rooms are isolated.
	if err := s.Append("r2", []byte("other")); err != nil {
		t.Fatal(err)
	}
	log, _ = s.Load("r1")
	if len(log) != 2 {
		t.Fatal("r2 write leaked into r1")
	}
}

func TestMemStore(t *testing.T) { testStore(t, NewMemStore()) }

func TestFSStore(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	testStore(t, s)
}

func TestFSStoreSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	s1, _ := NewFSStore(dir)
	if err := s1.Append("persist", []byte("data")); err != nil {
		t.Fatal(err)
	}
	s2, _ := NewFSStore(dir)
	log, err := s2.Load("persist")
	if err != nil || len(log) != 1 || string(log[0]) != "data" {
		t.Fatalf("reopen: %q, %v", log, err)
	}
}

func TestFSStoreRoomNameEscaping(t *testing.T) {
	s, _ := NewFSStore(t.TempDir())
	// Even though the server validates names, the store must not be traversable.
	if err := s.Append("../../evil", []byte("x")); err != nil {
		t.Fatal(err)
	}
	log, err := s.Load("../../evil")
	if err != nil || len(log) != 1 {
		t.Fatalf("escaped name roundtrip failed: %v", err)
	}
}
