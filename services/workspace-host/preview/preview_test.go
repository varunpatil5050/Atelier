package preview

import (
	"reflect"
	"sort"
	"sync"
	"testing"
)

func TestParsePS(t *testing.T) {
	out := `  100     1
  200   100
  300   200
badline
  400   xyz
`
	m := parsePS(out)
	want := map[int]int{100: 1, 200: 100, 300: 200}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("parsePS = %v, want %v", m, want)
	}
}

func TestDescendantSet(t *testing.T) {
	// 100 → 200 → 300, and 100 → 210; 999 unrelated.
	ppid := map[int]int{200: 100, 300: 200, 210: 100, 999: 1}
	got := descendantSet([]int{100}, ppid)
	for _, pid := range []int{100, 200, 300, 210} {
		if !got[pid] {
			t.Errorf("expected %d in descendant set", pid)
		}
	}
	if got[999] {
		t.Error("unrelated pid 999 should not be in the set")
	}
}

func TestParseLsof(t *testing.T) {
	// Realistic macOS/Linux lsof default output, incl. IPv6 and a non-LISTEN row.
	out := `COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
node    4321  dev    23u  IPv4  0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    4321  dev    24u  IPv6  0x5678      0t0  TCP [::1]:3000 (LISTEN)
python  4400  dev    3u   IPv4  0x9abc      0t0  TCP *:8000 (LISTEN)
node    4321  dev    30u  IPv4  0xdef0      0t0  TCP 127.0.0.1:3000->127.0.0.1:55123 (ESTABLISHED)
`
	got := parseLsof(out)
	// Both LISTEN sockets on :3000 plus :8000; the ESTABLISHED row is ignored.
	var ports []int
	for _, l := range got {
		ports = append(ports, l.Port)
	}
	sort.Ints(ports)
	want := []int{3000, 3000, 8000}
	if !reflect.DeepEqual(ports, want) {
		t.Fatalf("parseLsof ports = %v, want %v", ports, want)
	}
}

func TestFilterListenersDedupesAndScopes(t *testing.T) {
	all := []Listener{
		{Port: 3000, PID: 4321, Cmd: "node"},
		{Port: 3000, PID: 4321, Cmd: "node"}, // dup (IPv4+IPv6)
		{Port: 8000, PID: 4400, Cmd: "python"},
		{Port: 9090, PID: 5000, Cmd: "prometheus"}, // not in subtree
	}
	desc := map[int]bool{4321: true, 4400: true}
	got := filterListeners(all, desc)
	if len(got) != 2 {
		t.Fatalf("got %d listeners, want 2 (%+v)", len(got), got)
	}
	if got[0].Port != 3000 || got[1].Port != 8000 {
		t.Fatalf("ports = %d,%d want 3000,8000", got[0].Port, got[1].Port)
	}
}

// ── watcher ──────────────────────────────────────────────────────────────

type fakeLister struct{ listeners []Listener }

func (f *fakeLister) Listening([]int) ([]Listener, error) { return f.listeners, nil }

type fakeRegistrar struct {
	mu           sync.Mutex
	registered   map[int]string // port → target
	unregistered []int
}

func newFakeReg() *fakeRegistrar { return &fakeRegistrar{registered: map[int]string{}} }

func (r *fakeRegistrar) Register(port int, target, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.registered[port] = target
	return nil
}
func (r *fakeRegistrar) Unregister(port int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.registered, port)
	r.unregistered = append(r.unregistered, port)
	return nil
}

func TestWatcherRegistersAndUnregistersOnChange(t *testing.T) {
	lister := &fakeLister{}
	reg := newFakeReg()
	w := &Watcher{
		Lister:     lister,
		Reg:        reg,
		RootPIDs:   func() []int { return []int{100} },
		TargetHost: "127.0.0.1",
	}
	w.known = map[int]string{}

	// Tick 1: a dev server appears on 3000.
	lister.listeners = []Listener{{Port: 3000, PID: 200, Cmd: "vite"}}
	w.tick()
	if reg.registered[3000] != "127.0.0.1:3000" {
		t.Fatalf("expected 3000 registered to 127.0.0.1:3000, got %v", reg.registered)
	}

	// Tick 2: a second server on 8000; 3000 still up (heartbeat).
	lister.listeners = []Listener{
		{Port: 3000, PID: 200, Cmd: "vite"},
		{Port: 8000, PID: 201, Cmd: "api"},
	}
	w.tick()
	if len(reg.registered) != 2 {
		t.Fatalf("expected 2 previews, got %v", reg.registered)
	}

	// Tick 3: 3000 goes away → unregistered; 8000 stays.
	lister.listeners = []Listener{{Port: 8000, PID: 201, Cmd: "api"}}
	w.tick()
	if _, up := reg.registered[3000]; up {
		t.Fatal("3000 should be unregistered after it closed")
	}
	if _, up := reg.registered[8000]; !up {
		t.Fatal("8000 should still be registered")
	}
	if len(reg.unregistered) != 1 || reg.unregistered[0] != 3000 {
		t.Fatalf("unregistered = %v, want [3000]", reg.unregistered)
	}
}

func TestWatcherDrainUnregistersAll(t *testing.T) {
	reg := newFakeReg()
	w := &Watcher{Reg: reg}
	w.known = map[int]string{3000: "vite", 8000: "api"}
	w.drain()
	sort.Ints(reg.unregistered)
	if !reflect.DeepEqual(reg.unregistered, []int{3000, 8000}) {
		t.Fatalf("drain unregistered %v, want [3000 8000]", reg.unregistered)
	}
}
