// Package server is core-api's HTTP surface: dev sessions, workspaces, and
// room-token minting (blueprint doc 01 §B.4 lifecycle 1, doc 10 §6).
//
// v0 auth model: anonymous server-issued identities in a signed cookie. The
// *shape* is production-correct — identity is minted and verified server-side,
// never client-asserted — while OIDC/SSO slots in behind the same session
// surface later.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"time"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/pkg/wire"
	"atelier.dev/services/core-api/store"
)

const (
	sessionCookie = "atelier_session"
	sessionTTL    = 30 * 24 * time.Hour
	// RoomTokenTTL is short by design: tokens authorize one connection
	// attempt; the web client mints a fresh one per (re)connect.
	RoomTokenTTL = 2 * time.Minute
)

type Config struct {
	SessionSecret   []byte
	RoomTokenSecret []byte
}

type Server struct {
	store          store.Store
	log            *slog.Logger
	cfg            Config
	metricsHandler http.Handler
}

func New(st store.Store, logger *slog.Logger, cfg Config) *Server {
	return &Server{store: st, log: logger, cfg: cfg}
}

// SetMetricsHandler mounts a Prometheus /metrics endpoint (obs.InitMetrics).
func (s *Server) SetMetricsHandler(h http.Handler) { s.metricsHandler = h }

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("POST /v1/session", s.handleSession)
	mux.HandleFunc("POST /v1/rooms/{room}/token", s.handleRoomToken)
	mux.HandleFunc("GET /v1/workspaces", s.handleListWorkspaces)
	mux.HandleFunc("POST /v1/rum", s.handleRum)
	if s.metricsHandler != nil {
		mux.Handle("GET /metrics", s.metricsHandler)
	}
	return corsMiddleware(metricsMiddleware(mux))
}

// ── handlers ─────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSession returns the current identity, minting one (and its cookie)
// if absent or invalid.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.sessionUser(r)
	if !ok {
		user = randomUser()
		if err := s.store.EnsureUser(r.Context(), store.User{ID: user.ID, Name: user.Name, Color: user.Color}); err != nil {
			s.log.Error("ensure user", "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
			return
		}
		cookieTok, err := authtoken.Mint(s.cfg.SessionSecret, authtoken.Claims{
			User:      user,
			IssuedAt:  time.Now().Unix(),
			ExpiresAt: time.Now().Add(sessionTTL).Unix(),
		})
		if err != nil {
			s.log.Error("mint session", "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session mint failed"})
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: cookieTok, Path: "/",
			MaxAge: int(sessionTTL.Seconds()), HttpOnly: true, SameSite: http.SameSiteLaxMode,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleRoomToken(w http.ResponseWriter, r *http.Request) {
	user, ok := s.sessionUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no session"})
		return
	}
	roomName := r.PathValue("room")
	if !wire.ValidRoomName(roomName) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid room name"})
		return
	}

	ws, err := s.store.TouchWorkspace(r.Context(), roomName, user.ID)
	if err != nil {
		s.log.Error("touch workspace", "room", roomName, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}

	token, err := authtoken.Mint(s.cfg.RoomTokenSecret, authtoken.Claims{
		Room:      roomName,
		User:      user,
		IssuedAt:  time.Now().Unix(),
		ExpiresAt: time.Now().Add(RoomTokenTTL).Unix(),
	})
	if err != nil {
		s.log.Error("mint room token", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "token mint failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  user,
		"workspace": map[string]any{
			"id": ws.ID, "slug": ws.Slug, "name": ws.Name,
		},
	})
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.sessionUser(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no session"})
		return
	}
	list, err := s.store.ListWorkspaces(r.Context(), 20)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, ws := range list {
		out = append(out, map[string]any{
			"id": ws.ID, "slug": ws.Slug, "name": ws.Name,
			"lastOpenedAt": ws.LastOpenedAt.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": out})
}

// ── session plumbing ─────────────────────────────────────────────────────

func (s *Server) sessionUser(r *http.Request) (wire.UserInfo, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return wire.UserInfo{}, false
	}
	claims, err := authtoken.Verify(s.cfg.SessionSecret, c.Value, time.Now())
	if err != nil || claims.User.ID == "" {
		return wire.UserInfo{}, false
	}
	return claims.User, true
}

// ── helpers ──────────────────────────────────────────────────────────────

var localOriginRe = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

// corsMiddleware allows credentialed requests from local dev origins.
// Production narrows this to the configured app origin.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && localOriginRe.MatchString(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var (
	adjectives = []string{"amber", "brisk", "coral", "dusky", "eager", "fuzzy", "gilded", "hazel", "ivory", "jade", "keen", "lunar", "mossy", "noble", "opal", "plucky"}
	animals    = []string{"otter", "falcon", "lynx", "heron", "badger", "iguana", "magpie", "narwhal", "ocelot", "puffin", "quokka", "raven", "stoat", "tapir", "urchin", "vole"}
	colors     = []string{"#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#8b5cf6", "#06b6d4"}
)

func randomUser() wire.UserInfo {
	return wire.UserInfo{
		ID:    "u_" + randomHex(8),
		Name:  pick(adjectives) + "-" + pick(animals),
		Color: pick(colors),
	}
}

func pick(list []string) string {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(list))))
	if err != nil {
		panic("server: crypto/rand unavailable: " + err.Error())
	}
	return list[n.Int64()]
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("server: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
