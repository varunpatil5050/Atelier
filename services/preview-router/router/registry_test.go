package router

import (
	"testing"
	"time"
)

func TestRegistryUpsertLookupList(t *testing.T) {
	r := NewRegistry(time.Minute)
	r.Upsert("demo", 3000, "127.0.0.1:40001", "vite")
	r.Upsert("demo", 8080, "127.0.0.1:40002", "api")
	r.Upsert("other", 3000, "127.0.0.1:40003", "")

	got, ok := r.Lookup("demo", 3000)
	if !ok || got.Target != "127.0.0.1:40001" || got.Name != "vite" {
		t.Fatalf("lookup demo:3000 = %+v, ok=%v", got, ok)
	}

	list := r.ListRoom("demo")
	if len(list) != 2 {
		t.Fatalf("demo has %d previews, want 2", len(list))
	}
	if list[0].Port != 3000 || list[1].Port != 8080 {
		t.Fatalf("list not ordered by port: %+v", list)
	}
}

func TestRegistryUpsertRefreshesAndKeepsName(t *testing.T) {
	r := NewRegistry(time.Minute)
	r.Upsert("demo", 3000, "127.0.0.1:1", "vite")
	// A heartbeat with no name (workspace re-register) must keep the label and
	// update the target.
	r.Upsert("demo", 3000, "127.0.0.1:2", "")
	got, _ := r.Lookup("demo", 3000)
	if got.Target != "127.0.0.1:2" || got.Name != "vite" {
		t.Fatalf("after refresh = %+v, want target 127.0.0.1:2 name vite", got)
	}
}

func TestRegistryTTLExpiry(t *testing.T) {
	r := NewRegistry(10 * time.Second)
	now := time.Unix(1000, 0)
	r.now = func() time.Time { return now }
	r.Upsert("demo", 3000, "127.0.0.1:1", "x")

	if _, ok := r.Lookup("demo", 3000); !ok {
		t.Fatal("fresh route should be live")
	}
	now = now.Add(11 * time.Second) // past ttl
	if _, ok := r.Lookup("demo", 3000); ok {
		t.Fatal("expired route should not be looked up")
	}
	if len(r.ListRoom("demo")) != 0 {
		t.Fatal("expired route should not be listed")
	}
	if dropped := r.Sweep(); dropped != 1 {
		t.Fatalf("Sweep dropped %d, want 1", dropped)
	}
}

func TestRegistryRemove(t *testing.T) {
	r := NewRegistry(time.Minute)
	r.Upsert("demo", 3000, "127.0.0.1:1", "x")
	r.Remove("demo", 3000)
	if _, ok := r.Lookup("demo", 3000); ok {
		t.Fatal("removed route should be gone")
	}
	r.Remove("demo", 9999) // no-op, must not panic
}
