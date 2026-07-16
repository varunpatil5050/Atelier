package room

import (
	"encoding/json"

	"atelier.dev/pkg/wire"
)

// CTRL channel JSON messages — the Go twin of packages/protocol/src/ctrl.ts.
// Shared shapes live in pkg/wire so workspace-host speaks the same dialect.

// UserInfo identifies a human (later: agent) participant.
type UserInfo = wire.UserInfo

// ClientCtrl is any client→server CTRL message (fields are a union).
type ClientCtrl = wire.CtrlMsg

func unmarshalCtrl(payload []byte, dst *ClientCtrl) error {
	return json.Unmarshal(payload, dst)
}

func ctrlFrame(v any) []byte {
	payload, err := json.Marshal(v)
	if err != nil {
		// All ctrl values are plain structs; marshal cannot fail at runtime.
		panic("room: ctrl marshal: " + err.Error())
	}
	return wire.Encode(wire.Frame{Channel: wire.ChCtrl, Payload: payload})
}

func ctrlWelcome(clientID, room string, logLen int) []byte {
	return ctrlFrame(struct {
		Type     string `json:"type"`
		ClientID string `json:"clientId"`
		Room     string `json:"room"`
		LogLen   int    `json:"logLen"`
	}{"welcome", clientID, room, logLen})
}

func ctrlSyncDone() []byte {
	return ctrlFrame(struct {
		Type string `json:"type"`
	}{"sync_done"})
}

func ctrlPong(t float64) []byte {
	return ctrlFrame(struct {
		Type string  `json:"type"`
		T    float64 `json:"t"`
	}{"pong", t})
}

func ctrlCompactRequest() []byte {
	return ctrlFrame(struct {
		Type string `json:"type"`
	}{"compact_request"})
}

func ctrlPeerJoined(clientID string, user UserInfo) []byte {
	return ctrlFrame(struct {
		Type     string   `json:"type"`
		ClientID string   `json:"clientId"`
		User     UserInfo `json:"user"`
	}{"peer_joined", clientID, user})
}

func ctrlPeerLeft(clientID string) []byte {
	return ctrlFrame(struct {
		Type     string `json:"type"`
		ClientID string `json:"clientId"`
	}{"peer_left", clientID})
}

func ctrlHostStatus(online bool) []byte {
	return ctrlFrame(struct {
		Type   string `json:"type"`
		Online bool   `json:"online"`
	}{"host_status", online})
}

func ctrlError(code, msg string) []byte {
	return ctrlFrame(struct {
		Type string `json:"type"`
		Code string `json:"code"`
		Msg  string `json:"msg"`
	}{"error", code, msg})
}
