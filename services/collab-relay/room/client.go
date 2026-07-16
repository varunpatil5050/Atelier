package room

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"github.com/coder/websocket"

	"atelier.dev/pkg/wire"
)

// sendQueueSize bounds per-client buffering. A client that can't drain this
// many messages is treated as dead (doc 04 §4 backpressure rule: a slow tab
// must never stall the room goroutine). Sized generously because join replay
// is pre-batched into few large messages.
const sendQueueSize = 512

// Client is one WebSocket connection's room membership.
//
// Concurrency invariants:
//   - Only the room goroutine sends on `send` (via trySend) and only the room
//     goroutine calls shutdown() — so closing `send` is race-free.
//   - The write pump is the only writer to the socket.
//   - The read pump is the only reader; on any error it enqueues leave.
type Client struct {
	ID   string
	User UserInfo
	Role string // wire.RoleParticipant | wire.RoleHost

	room *Room
	conn *websocket.Conn
	send chan []byte

	closeOnce sync.Once
}

// NewClient wires a connection into a room and returns once pumps are started.
// It blocks in the read pump; call from the HTTP handler goroutine.
func NewClient(ctx context.Context, conn *websocket.Conn, r *Room, user UserInfo, role string) {
	c := &Client{
		ID:   newID(),
		User: user,
		Role: role,
		room: r,
		conn: conn,
		send: make(chan []byte, sendQueueSize),
	}
	mConns.Add(ctx, 1)
	defer mConns.Add(bg, -1)
	go c.writePump()
	r.Join(c)
	c.readPump(ctx)
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("room: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// trySend enqueues an encoded message without blocking. Returns false if the
// client's queue is full (caller decides to kick).
func (c *Client) trySend(buf []byte) bool {
	select {
	case c.send <- buf:
		return true
	default:
		return false
	}
}

// shutdown closes the send queue (write pump then closes the socket, which
// unblocks the read pump). Room-goroutine only; idempotent.
func (c *Client) shutdown() {
	c.closeOnce.Do(func() { close(c.send) })
}

func (c *Client) readPump(ctx context.Context) {
	defer c.room.leave(c)
	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary {
			continue // protocol is binary-only; ignore stray text frames
		}
		frames, err := wire.DecodeAll(data)
		if err != nil {
			c.conn.Close(websocket.StatusProtocolError, "malformed frame")
			return
		}
		for _, f := range frames {
			c.room.submit(c, f)
		}
	}
}

func (c *Client) writePump() {
	ctx := context.Background()
	for buf := range c.send {
		if err := c.conn.Write(ctx, websocket.MessageBinary, buf); err != nil {
			// Socket dead: drain remaining queued messages so the room's
			// trySend never blocks, then let the read pump's error path
			// drive the leave.
			for range c.send {
			}
			break
		}
	}
	c.conn.Close(websocket.StatusNormalClosure, "")
}
