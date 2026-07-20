// Package router implements the preview-router (blueprint doc 05 §7): the edge
// that turns a workspace's running dev server into a shareable URL. A workspace
// declares a listening port; the router registers {room, port} → a backend
// target and proxies HTTP/WebSocket traffic to it at
// https://{port}--{room}.preview.<domain>.
//
// In the microVM end state the guest-agent's netlink watcher declares ports and
// the warden registers them; here the workspace-host does the same against the
// same registration API — the seam is unchanged, only the caller moves.
package router

import (
	"sort"
	"sync"
	"time"
)

// Route is one live preview: a workspace port mapped to a proxy target.
type Route struct {
	Room     string    `json:"room"`
	Port     int       `json:"port"`
	Target   string    `json:"target"` // host:port the proxy dials (never sent to browsers)
	Name     string    `json:"name"`   // optional label (e.g. the process name)
	LastSeen time.Time `json:"lastSeen"`
}

// Registry holds live routes. Entries are kept fresh by heartbeat: a registrar
// re-registers on a short interval, and anything not seen within ttl is swept.
// This makes crashed dev servers and killed workspaces self-heal without an
// explicit unregister (which is still honored when it arrives).
type Registry struct {
	mu     sync.RWMutex
	ttl    time.Duration
	routes map[string]*Route
	now    func() time.Time // injectable for tests
}

func NewRegistry(ttl time.Duration) *Registry {
	return &Registry{
		ttl:    ttl,
		routes: make(map[string]*Route),
		now:    time.Now,
	}
}

func key(room string, port int) string {
	return room + "/" + itoa(port)
}

// Upsert registers or refreshes a route, stamping LastSeen.
func (r *Registry) Upsert(room string, port int, target, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := key(room, port)
	if existing, ok := r.routes[k]; ok {
		existing.Target = target
		if name != "" {
			existing.Name = name
		}
		existing.LastSeen = r.now()
		return
	}
	r.routes[k] = &Route{Room: room, Port: port, Target: target, Name: name, LastSeen: r.now()}
}

// Remove drops a route (explicit unregister). No-op if absent.
func (r *Registry) Remove(room string, port int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.routes, key(room, port))
}

// Lookup returns a live (non-expired) route for proxying.
func (r *Registry) Lookup(room string, port int) (Route, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rt, ok := r.routes[key(room, port)]
	if !ok || r.expired(rt) {
		return Route{}, false
	}
	return *rt, true
}

// ListRoom returns the room's live routes, ordered by port for stable UIs.
func (r *Registry) ListRoom(room string) []Route {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Route
	for _, rt := range r.routes {
		if rt.Room == room && !r.expired(rt) {
			out = append(out, *rt)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// Sweep drops expired routes; call it on a ticker so the map doesn't grow.
func (r *Registry) Sweep() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	dropped := 0
	for k, rt := range r.routes {
		if r.expired(rt) {
			delete(r.routes, k)
			dropped++
		}
	}
	return dropped
}

func (r *Registry) expired(rt *Route) bool {
	return r.now().Sub(rt.LastSeen) > r.ttl
}

// itoa avoids strconv import churn for a hot, tiny conversion.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
