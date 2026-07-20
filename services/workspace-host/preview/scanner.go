// Package preview auto-detects dev servers a workspace starts and registers
// them with the preview-router (blueprint doc 05 §7). This is the local-dev
// stand-in for the microVM guest-agent's netlink port watcher: same idea —
// "the workspace declared a listening port" — reported to the same router API.
//
// It watches the process subtree rooted at the workspace's shells, so it only
// surfaces ports the *workspace* opened (not the relay, the web dev server, or
// anything else on the machine).
package preview

import (
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// Listener is a detected listening TCP socket owned by the workspace.
type Listener struct {
	Port int
	PID  int
	Cmd  string
}

// PortLister reports listening ports owned by a set of root PIDs and their
// descendants. Implementations are OS-specific; the seam keeps the watcher
// testable without touching the machine.
type PortLister interface {
	Listening(rootPIDs []int) ([]Listener, error)
}

// LsofLister uses lsof + ps to find listening sockets in the workspace's
// process subtree. Works on macOS and Linux dev machines.
type LsofLister struct{}

func (LsofLister) Listening(rootPIDs []int) ([]Listener, error) {
	if len(rootPIDs) == 0 {
		return nil, nil
	}
	psOut, err := exec.Command("ps", "-axo", "pid=,ppid=").Output()
	if err != nil {
		return nil, err
	}
	desc := descendantSet(rootPIDs, parsePS(string(psOut)))

	// lsof exits non-zero when nothing matches; that's not an error for us.
	lsofOut, _ := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN").Output()
	return filterListeners(parseLsof(string(lsofOut)), desc), nil
}

// parsePS turns `ps -axo pid=,ppid=` output into a pid→ppid map.
func parsePS(out string) map[int]int {
	m := make(map[int]int)
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			m[pid] = ppid
		}
	}
	return m
}

// descendantSet returns roots plus every process transitively parented by them.
func descendantSet(roots []int, ppid map[int]int) map[int]bool {
	// children adjacency
	children := make(map[int][]int)
	for pid, parent := range ppid {
		children[parent] = append(children[parent], pid)
	}
	seen := make(map[int]bool)
	stack := append([]int(nil), roots...)
	for len(stack) > 0 {
		pid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		stack = append(stack, children[pid]...)
	}
	return seen
}

// parseLsof parses default `lsof` tabular output into listeners. The address
// sits in the field just before "(LISTEN)"; the port is after its last colon
// (handles *:3000, 127.0.0.1:3000, and [::1]:3000).
func parseLsof(out string) []Listener {
	var out2 []Listener
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[0] == "COMMAND" {
			continue
		}
		listenIdx := -1
		for i, tok := range f {
			if tok == "(LISTEN)" {
				listenIdx = i
				break
			}
		}
		if listenIdx < 1 {
			continue
		}
		addr := f[listenIdx-1]
		colon := strings.LastIndex(addr, ":")
		if colon < 0 {
			continue
		}
		port, err := strconv.Atoi(addr[colon+1:])
		if err != nil || port < 1 || port > 65535 {
			continue
		}
		pid, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		out2 = append(out2, Listener{Port: port, PID: pid, Cmd: f[0]})
	}
	return out2
}

// filterListeners keeps only sockets owned by the workspace subtree, deduped by
// port (a server may bind the same port on several addresses/fds).
func filterListeners(all []Listener, desc map[int]bool) []Listener {
	byPort := make(map[int]Listener)
	for _, l := range all {
		if !desc[l.PID] {
			continue
		}
		if _, seen := byPort[l.Port]; !seen {
			byPort[l.Port] = l
		}
	}
	out := make([]Listener, 0, len(byPort))
	for _, l := range byPort {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}
