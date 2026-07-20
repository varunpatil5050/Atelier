package router

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/pkg/wire"
)

// Options configure the router. Zero values give a working dev-open server on
// preview.localhost with no auth (mirrors the relay's tokenless dev mode).
type Options struct {
	// Domain is the preview wildcard base, e.g. "preview.localhost". Requests to
	// {port}--{room}.<Domain> are proxied.
	Domain string
	// PublicPort is the port browsers reach the router on (for building URLs).
	PublicPort int
	// PathHost is the host used in the /_p/ fallback URL (always resolvable),
	// e.g. "localhost".
	PathHost string
	// RegisterSecret, when set, is required in the X-Preview-Secret header on
	// register/unregister (service-to-service auth).
	RegisterSecret string
	// ShareSecret, when set, gates proxied traffic: a valid preview token (query
	// ?__atelier_preview or cookie) scoped to the room is required. When nil the
	// preview is public (dev default).
	ShareSecret []byte
}

// Server is the preview-router HTTP handler: control API + reverse proxy.
type Server struct {
	reg     *Registry
	opts    Options
	log     *slog.Logger
	control http.Handler
}

func New(reg *Registry, opts Options, log *slog.Logger) *Server {
	if opts.Domain == "" {
		opts.Domain = "preview.localhost"
	}
	if opts.PathHost == "" {
		opts.PathHost = "localhost"
	}
	if opts.PublicPort == 0 {
		opts.PublicPort = 8790
	}
	if log == nil {
		log = slog.Default()
	}
	s := &Server{reg: reg, opts: opts, log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("POST /v1/register", s.handleRegister)
	mux.HandleFunc("POST /v1/unregister", s.handleUnregister)
	mux.HandleFunc("GET /v1/previews/{room}", s.handleList)
	mux.HandleFunc("OPTIONS /v1/previews/{room}", s.handleCORSPreflight)
	s.control = mux
	return s
}

// ServeHTTP routes by host then path: a preview subdomain or a /_p/ path is
// proxied to the workspace; everything else is the control API. Gating the
// control endpoints on host+path this way means a proxied app's own /v1/* or
// /healthz routes are never shadowed by the router.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := hostOnly(r.Host)
	if room, port, ok := s.matchSubdomain(host); ok {
		s.proxy(w, r, room, port, "")
		return
	}
	if room, port, rest, ok := matchPath(r.URL.Path); ok {
		s.proxy(w, r, room, port, rest)
		return
	}
	s.control.ServeHTTP(w, r)
}

// ── control API ────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type registerReq struct {
	Room   string `json:"room"`
	Port   int    `json:"port"`
	Target string `json:"target"`
	Name   string `json:"name"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.registerAuthed(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req registerReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if !wire.ValidRoomName(req.Room) || req.Port < 1 || req.Port > 65535 || req.Target == "" {
		http.Error(w, "invalid room/port/target", http.StatusBadRequest)
		return
	}
	s.reg.Upsert(req.Room, req.Port, req.Target, req.Name)
	writeJSON(w, http.StatusOK, map[string]any{
		"url":     s.subdomainURL(req.Room, req.Port),
		"pathUrl": s.pathURL(req.Room, req.Port),
	})
}

func (s *Server) handleUnregister(w http.ResponseWriter, r *http.Request) {
	if !s.registerAuthed(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req registerReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	s.reg.Remove(req.Room, req.Port)
	w.WriteHeader(http.StatusNoContent)
}

// previewView is the browser-facing shape: the internal Target is never exposed.
type previewView struct {
	Room    string `json:"room"`
	Port    int    `json:"port"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	PathURL string `json:"pathUrl"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	room := r.PathValue("room")
	if !wire.ValidRoomName(room) {
		http.Error(w, "invalid room", http.StatusBadRequest)
		return
	}
	routes := s.reg.ListRoom(room)
	views := make([]previewView, 0, len(routes))
	for _, rt := range routes {
		views = append(views, previewView{
			Room: rt.Room, Port: rt.Port, Name: rt.Name,
			URL:     s.subdomainURL(rt.Room, rt.Port),
			PathURL: s.pathURL(rt.Room, rt.Port),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"previews": views})
}

func (s *Server) handleCORSPreflight(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// ── proxy ────────────────────────────────────────────────────────────────

// proxy forwards to the workspace's dev server. pathPrefix is the /_p/{room}/{port}
// prefix to strip (empty for subdomain routing, where the app is served at root).
func (s *Server) proxy(w http.ResponseWriter, r *http.Request, room string, port int, pathPrefix string) {
	if !s.shareAuthed(r, room) {
		http.Error(w, "preview requires a share token", http.StatusUnauthorized)
		return
	}
	rt, ok := s.reg.Lookup(room, port)
	if !ok {
		http.Error(w, fmt.Sprintf("no preview registered for %s port %d — is the dev server running?", room, port), http.StatusBadGateway)
		return
	}
	target := &url.URL{Scheme: "http", Host: rt.Target}
	rp := &httputil.ReverseProxy{
		FlushInterval: -1, // stream responses (SSE, long polls) without buffering
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			if pathPrefix != "" {
				// path-routing: rewrite /_p/{room}/{port}/foo → /foo
				req.URL.Path = ensureLeadingSlash(strings.TrimPrefix(req.URL.Path, pathPrefix))
			}
			req.Header.Set("X-Forwarded-Host", hostOnly(req.Host))
			req.Header.Set("X-Forwarded-Proto", "http")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			s.log.Warn("preview upstream error", "room", room, "port", port, "err", err)
			http.Error(w, "preview upstream unreachable", http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}

// ── auth ────────────────────────────────────────────────────────────────

func (s *Server) registerAuthed(r *http.Request) bool {
	if s.opts.RegisterSecret == "" {
		return true // dev-open
	}
	return r.Header.Get("X-Preview-Secret") == s.opts.RegisterSecret
}

// shareAuthed enforces the private-by-default policy when a ShareSecret is set:
// the request must carry a preview token (query or cookie) scoped to this room.
func (s *Server) shareAuthed(r *http.Request, room string) bool {
	if s.opts.ShareSecret == nil {
		return true // public dev default
	}
	tok := r.URL.Query().Get("__atelier_preview")
	if tok == "" {
		if c, err := r.Cookie("atelier_preview"); err == nil {
			tok = c.Value
		}
	}
	if tok == "" {
		return false
	}
	claims, err := authtoken.Verify(s.opts.ShareSecret, tok, time.Now())
	if err != nil {
		return false
	}
	return claims.Room == room
}

// ── URL + host helpers ─────────────────────────────────────────────────────

func (s *Server) portSuffix() string {
	if s.opts.PublicPort == 80 || s.opts.PublicPort == 443 {
		return ""
	}
	return ":" + strconv.Itoa(s.opts.PublicPort)
}

func (s *Server) subdomainURL(room string, port int) string {
	return fmt.Sprintf("http://%d--%s.%s%s/", port, room, s.opts.Domain, s.portSuffix())
}

func (s *Server) pathURL(room string, port int) string {
	return fmt.Sprintf("http://%s%s/_p/%s/%d/", s.opts.PathHost, s.portSuffix(), room, port)
}

// matchSubdomain parses "{port}--{room}" out of a preview host. Splitting on the
// first "--" is unambiguous because the port segment is all digits (room names
// may themselves contain "--").
func (s *Server) matchSubdomain(host string) (room string, port int, ok bool) {
	suffix := "." + s.opts.Domain
	if !strings.HasSuffix(host, suffix) {
		return "", 0, false
	}
	label := strings.TrimSuffix(host, suffix)
	p, rest, found := strings.Cut(label, "--")
	if !found {
		return "", 0, false
	}
	port, err := strconv.Atoi(p)
	if err != nil || port < 1 || port > 65535 || !wire.ValidRoomName(rest) {
		return "", 0, false
	}
	return rest, port, true
}

var pathRe = regexp.MustCompile(`^/_p/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/(\d{1,5})(/.*)?$`)

// matchPath parses the /_p/{room}/{port}/... fallback. Returns the prefix to
// strip so the backend sees a root-relative path.
func matchPath(p string) (room string, port int, prefix string, ok bool) {
	m := pathRe.FindStringSubmatch(p)
	if m == nil {
		return "", 0, "", false
	}
	port, err := strconv.Atoi(m[2])
	if err != nil || port < 1 || port > 65535 {
		return "", 0, "", false
	}
	return m[1], port, "/_p/" + m[1] + "/" + m[2], true
}

func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); localOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	}
}

var localOriginRe = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

func localOrigin(origin string) bool {
	return origin != "" && localOriginRe.MatchString(origin)
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

func ensureLeadingSlash(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		return "/" + p
	}
	return p
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
