// Package wsproto implements the Atelier WebSocket wire format:
//
//	[u8 channel][u8 flags][u16 streamId (big-endian)][varint payloadLen][payload]
//
// It must stay byte-identical with packages/protocol (TypeScript). Both sides
// are pinned by packages/protocol/fixtures/frames.json golden vectors.
package wire

import (
	"errors"
	"fmt"
)

// Channels.
const (
	ChCtrl  byte = 1
	ChCRDT  byte = 2
	ChAware byte = 3
	ChPty   byte = 4
	ChExec  byte = 5
	ChLsp   byte = 6
	ChAgent byte = 7
	ChFs    byte = 8
)

// Flags.
const (
	FlagCompressed byte = 0x01
	FlagBatch      byte = 0x02
	FlagTrace      byte = 0x04
	// FlagCompact marks a CRDT payload as a full-state snapshot that replaces
	// the room's update log (client-driven compaction).
	FlagCompact byte = 0x08
)

// MaxPayload guards against hostile frames. 8 MiB comfortably fits any
// realistic compaction snapshot for v0.
const MaxPayload = 8 << 20

const headerFixed = 4 // channel + flags + streamId

var (
	ErrShortBuffer = errors.New("wsproto: buffer too short")
	ErrVarint      = errors.New("wsproto: malformed varint")
)

// Frame is a single protocol frame.
type Frame struct {
	Channel  byte
	Flags    byte
	StreamID uint16
	Payload  []byte
}

// Encode serializes a frame.
func Encode(f Frame) []byte {
	buf := make([]byte, 0, headerFixed+5+len(f.Payload))
	buf = append(buf, f.Channel, f.Flags, byte(f.StreamID>>8), byte(f.StreamID))
	buf = appendVarUint(buf, uint32(len(f.Payload)))
	return append(buf, f.Payload...)
}

// Decode parses one frame from buf, returning the frame and bytes consumed.
// Frame.Payload aliases buf; callers that retain payloads must copy.
func Decode(buf []byte) (Frame, int, error) {
	if len(buf) < headerFixed+1 {
		return Frame{}, 0, ErrShortBuffer
	}
	f := Frame{
		Channel:  buf[0],
		Flags:    buf[1],
		StreamID: uint16(buf[2])<<8 | uint16(buf[3]),
	}
	payloadLen, n, err := readVarUint(buf[headerFixed:])
	if err != nil {
		return Frame{}, 0, err
	}
	if payloadLen > MaxPayload {
		return Frame{}, 0, fmt.Errorf("wsproto: payload %d exceeds max %d", payloadLen, MaxPayload)
	}
	start := headerFixed + n
	end := start + int(payloadLen)
	if len(buf) < end {
		return Frame{}, 0, ErrShortBuffer
	}
	f.Payload = buf[start:end]
	return f, end, nil
}

// DecodeAll parses every frame in a message (frames may be batched).
func DecodeAll(buf []byte) ([]Frame, error) {
	var frames []Frame
	for off := 0; off < len(buf); {
		f, n, err := Decode(buf[off:])
		if err != nil {
			return nil, err
		}
		frames = append(frames, f)
		off += n
	}
	return frames, nil
}

func appendVarUint(dst []byte, v uint32) []byte {
	for v > 0x7f {
		dst = append(dst, byte(v&0x7f)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

func readVarUint(buf []byte) (uint32, int, error) {
	var value uint64
	var shift uint
	for i := 0; i < len(buf); i++ {
		if i > 4 {
			return 0, 0, ErrVarint
		}
		b := buf[i]
		value |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			if value > 0xffffffff {
				return 0, 0, ErrVarint
			}
			return uint32(value), i + 1, nil
		}
		shift += 7
	}
	return 0, 0, ErrShortBuffer
}
