// Package yaware encodes/decodes y-protocols awareness updates (lib0 format):
//
//	varUint(entryCount)
//	entryCount × [ varUint(clientID) varUint(clock) varString(stateJSON) ]
//
// where varString = varUint(byteLen) + UTF-8 bytes, and a removed client is
// encoded with stateJSON == "null". lib0 varints are LEB128 (up to 53 bits in
// JS; uint64 here).
//
// The relay parses awareness updates so it can (a) replay current presence to
// late joiners and (b) synthesize removal updates when a connection drops.
package yaware

import (
	"errors"
	"fmt"
)

// Entry is one client's awareness record.
type Entry struct {
	ClientID  uint64
	Clock     uint64
	StateJSON string // "null" for removal
}

var errShort = errors.New("yaware: unexpected end of buffer")

// Parse decodes an awareness update payload.
func Parse(payload []byte) ([]Entry, error) {
	count, off, err := readVarUint(payload, 0)
	if err != nil {
		return nil, err
	}
	if count > 1024 {
		return nil, fmt.Errorf("yaware: implausible entry count %d", count)
	}
	entries := make([]Entry, 0, count)
	for i := uint64(0); i < count; i++ {
		var e Entry
		e.ClientID, off, err = readVarUint(payload, off)
		if err != nil {
			return nil, err
		}
		e.Clock, off, err = readVarUint(payload, off)
		if err != nil {
			return nil, err
		}
		var strLen uint64
		strLen, off, err = readVarUint(payload, off)
		if err != nil {
			return nil, err
		}
		if uint64(len(payload)-off) < strLen {
			return nil, errShort
		}
		e.StateJSON = string(payload[off : off+int(strLen)])
		off += int(strLen)
		entries = append(entries, e)
	}
	return entries, nil
}

// Encode serializes entries as an awareness update payload.
func Encode(entries []Entry) []byte {
	buf := appendVarUint(nil, uint64(len(entries)))
	for _, e := range entries {
		buf = appendVarUint(buf, e.ClientID)
		buf = appendVarUint(buf, e.Clock)
		buf = appendVarUint(buf, uint64(len(e.StateJSON)))
		buf = append(buf, e.StateJSON...)
	}
	return buf
}

func appendVarUint(dst []byte, v uint64) []byte {
	for v > 0x7f {
		dst = append(dst, byte(v&0x7f)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

func readVarUint(buf []byte, off int) (uint64, int, error) {
	var value uint64
	var shift uint
	for i := off; i < len(buf); i++ {
		if i-off > 9 {
			return 0, 0, errors.New("yaware: varint too long")
		}
		b := buf[i]
		value |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return value, i + 1, nil
		}
		shift += 7
	}
	return 0, 0, errShort
}
