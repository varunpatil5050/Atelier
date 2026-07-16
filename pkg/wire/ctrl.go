package wire

import "regexp"

// Room names double as storage keys and routing keys — constrain them at the
// protocol level so every service validates identically.
var roomNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// ValidRoomName reports whether name is an acceptable room identifier.
func ValidRoomName(name string) bool { return roomNameRe.MatchString(name) }

// UserInfo identifies a participant (human, workspace host, later: agent).
type UserInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Roles a connection can claim in its hello.
const (
	RoleParticipant = ""     // default: human/agent editor client
	RoleHost        = "host" // workspace host: provides PTYs/exec for the room
)

// CtrlMsg is the JSON payload of CTRL-channel messages (client→server and
// host→server directions; field usage depends on Type). The TS twin lives in
// packages/protocol/src/ctrl.ts.
type CtrlMsg struct {
	Type string `json:"type"`

	// hello
	V    int       `json:"v,omitempty"`
	Room string    `json:"room,omitempty"`
	User *UserInfo `json:"user,omitempty"`
	Role string    `json:"role,omitempty"`
	// Token authenticates the hello when the relay enforces auth: a room
	// token (participants, minted by core-api) or the service secret
	// (workspace-host / doc-fs).
	Token string `json:"token,omitempty"`

	// ping / pong
	T float64 `json:"t,omitempty"`

	// pty_open / pty_resize / pty_close / pty_exit
	StreamID uint16 `json:"streamId,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
	Code     int    `json:"code,omitempty"`
}
