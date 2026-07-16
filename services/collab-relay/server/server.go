// Package server exposes the relay over HTTP: /ws (WebSocket) + /healthz.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"atelier.dev/pkg/authtoken"
	"atelier.dev/pkg/wire"
	"atelier.dev/services/collab-relay/room"
)

const (
	helloTimeout = 5 * time.Second
	readLimit    = wire.MaxPayload + 1024
)

// Options configures authentication. Zero value = tokenless dev mode
// (hello-asserted identity, logged loudly at startup).
type Options struct {
	// TokenSecret, when set, requires participants to present a valid room
	// token minted by core-api; identity then comes from the token's claims,
	// never from the hello body.
	TokenSecret []byte
	// ServiceSecret authenticates infrastructure connections (workspace-host,
	// doc-fs). Role=host is only obtainable through this path in token mode.
	ServiceSecret string
}

type Server struct {
	mgr            *room.Manager
	log            *slog.Logger
	opts           Options
	baseCtx        context.Context
	metricsHandler http.Handler
}

func New(mgr *room.Manager, logger *slog.Logger, opts Options) *Server {
	if len(opts.TokenSecret) == 0 {
		logger.Warn("relay running in TOKENLESS dev mode — set RELAY_TOKEN_SECRET to enforce auth")
	}
	return &Server{mgr: mgr, log: logger, opts: opts, baseCtx: context.Background()}
}

// SetBaseContext installs the process lifetime context; cancelling it drains
// all connection read loops.
func (s *Server) SetBaseContext(ctx context.Context) { s.baseCtx = ctx }

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /ws", s.handleWS)
	if s.metricsHandler != nil {
		mux.Handle("GET /metrics", s.metricsHandler)
	}
	return mux
}

// SetMetricsHandler mounts a Prometheus /metrics endpoint (obs.InitMetrics).
func (s *Server) SetMetricsHandler(h http.Handler) { s.metricsHandler = h }

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "rooms": s.mgr.Stats()})
}

// handleWS upgrades, requires a CTRL hello as the first frame, then joins the
// room. Auth is v0 (hello-asserted identity); production swaps this for the
// signed room-token handshake in blueprint doc 01 §B.4.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Dev origins; production uses exact origins from config.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		s.log.Warn("ws accept failed", "err", err)
		return
	}
	conn.SetReadLimit(readLimit)

	hello, err := s.readHello(conn)
	if err != nil {
		s.log.Warn("handshake failed", "err", err, "remote", r.RemoteAddr)
		conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}

	rm, err := s.mgr.Get(hello.Room)
	if err != nil {
		s.log.Error("room load failed", "room", hello.Room, "err", err)
		conn.Close(websocket.StatusInternalError, "room unavailable")
		return
	}

	// Blocks in the read pump for the connection's lifetime.
	room.NewClient(s.baseCtx, conn, rm, *hello.User, hello.Role)
}

func (s *Server) readHello(conn *websocket.Conn) (room.ClientCtrl, error) {
	ctx, cancel := context.WithTimeout(s.baseCtx, helloTimeout)
	defer cancel()

	typ, data, err := conn.Read(ctx)
	if err != nil {
		return room.ClientCtrl{}, fmt.Errorf("reading hello: %w", err)
	}
	if typ != websocket.MessageBinary {
		return room.ClientCtrl{}, fmt.Errorf("hello must be binary frame")
	}
	frames, err := wire.DecodeAll(data)
	if err != nil || len(frames) == 0 {
		return room.ClientCtrl{}, fmt.Errorf("malformed hello frame")
	}
	f := frames[0]
	if f.Channel != wire.ChCtrl {
		return room.ClientCtrl{}, fmt.Errorf("first frame must be CTRL, got channel %d", f.Channel)
	}
	var msg room.ClientCtrl
	if err := json.Unmarshal(f.Payload, &msg); err != nil {
		return room.ClientCtrl{}, fmt.Errorf("bad hello json: %w", err)
	}
	if msg.Type != "hello" || msg.V != 1 {
		return room.ClientCtrl{}, fmt.Errorf("expected hello v1, got %q v%d", msg.Type, msg.V)
	}
	if !room.ValidRoomName(msg.Room) {
		return room.ClientCtrl{}, fmt.Errorf("invalid room name")
	}
	if msg.User == nil || msg.User.ID == "" || msg.User.Name == "" {
		return room.ClientCtrl{}, fmt.Errorf("hello missing user identity")
	}
	if len(msg.User.Name) > 64 || len(msg.User.Color) > 16 {
		return room.ClientCtrl{}, fmt.Errorf("hello user fields too long")
	}
	if msg.Role != wire.RoleParticipant && msg.Role != wire.RoleHost {
		return room.ClientCtrl{}, fmt.Errorf("unknown role %q", msg.Role)
	}
	if err := s.authenticate(&msg); err != nil {
		return room.ClientCtrl{}, err
	}
	return msg, nil
}

// authenticate enforces auth when a token secret is configured. On success it
// may rewrite msg's identity fields from the token's claims — the hello body
// is never trusted for identity in token mode.
func (s *Server) authenticate(msg *room.ClientCtrl) error {
	if len(s.opts.TokenSecret) == 0 {
		return nil // tokenless dev mode
	}

	// Infrastructure path: exact service secret grants hello-asserted
	// identity and is the only way to claim role=host.
	if s.opts.ServiceSecret != "" &&
		subtle.ConstantTimeCompare([]byte(msg.Token), []byte(s.opts.ServiceSecret)) == 1 {
		return nil
	}
	if msg.Role == wire.RoleHost {
		return fmt.Errorf("host role requires the service secret")
	}

	claims, err := authtoken.Verify(s.opts.TokenSecret, msg.Token, time.Now())
	if err != nil {
		return fmt.Errorf("room token rejected: %w", err)
	}
	if claims.Room != msg.Room {
		return fmt.Errorf("room token is for a different room")
	}
	msg.User = &claims.User
	msg.Role = claims.Role
	return nil
}
