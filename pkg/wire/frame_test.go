package wire

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Golden vectors shared with packages/protocol (TypeScript).
type fixtureFile struct {
	Vectors []struct {
		Name               string `json:"name"`
		Channel            byte   `json:"channel"`
		Flags              byte   `json:"flags"`
		StreamID           uint16 `json:"streamId"`
		PayloadRepeatHex   string `json:"payloadRepeatHex"`
		PayloadRepeatCount int    `json:"payloadRepeatCount"`
		WireHeaderHex      string `json:"wireHeaderHex"`
	} `json:"vectors"`
}

func loadFixtures(t *testing.T) fixtureFile {
	t.Helper()
	path := filepath.Join("..", "..", "packages", "protocol", "fixtures", "frames.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading shared fixtures: %v", err)
	}
	var ff fixtureFile
	if err := json.Unmarshal(data, &ff); err != nil {
		t.Fatalf("parsing fixtures: %v", err)
	}
	if len(ff.Vectors) == 0 {
		t.Fatal("no fixture vectors")
	}
	return ff
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex in fixture: %v", err)
	}
	return b
}

func TestGoldenVectors(t *testing.T) {
	for _, v := range loadFixtures(t).Vectors {
		t.Run(v.Name, func(t *testing.T) {
			payload := mustHex(t, strings.Repeat(v.PayloadRepeatHex, v.PayloadRepeatCount))
			wire := append(mustHex(t, v.WireHeaderHex), payload...)

			got := Encode(Frame{Channel: v.Channel, Flags: v.Flags, StreamID: v.StreamID, Payload: payload})
			if !bytes.Equal(got, wire) {
				t.Fatalf("encode mismatch:\n got %x\nwant %x", got, wire)
			}

			f, n, err := Decode(wire)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if n != len(wire) {
				t.Fatalf("decode consumed %d, want %d", n, len(wire))
			}
			if f.Channel != v.Channel || f.Flags != v.Flags || f.StreamID != v.StreamID || !bytes.Equal(f.Payload, payload) {
				t.Fatalf("decode mismatch: %+v", f)
			}
		})
	}
}

func TestDecodeAllBatched(t *testing.T) {
	a := Encode(Frame{Channel: ChCtrl, Payload: []byte{1}})
	b := Encode(Frame{Channel: ChCRDT, Flags: FlagCompact, StreamID: 9, Payload: []byte{2, 3}})
	frames, err := DecodeAll(append(append([]byte{}, a...), b...))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 || frames[1].StreamID != 9 || frames[1].Flags != FlagCompact {
		t.Fatalf("bad batch decode: %+v", frames)
	}
}

func TestDecodeTruncated(t *testing.T) {
	full := Encode(Frame{Channel: ChCtrl, Payload: make([]byte, 10)})
	if _, _, err := Decode(full[:len(full)-1]); err == nil {
		t.Fatal("expected error on truncated payload")
	}
	if _, _, err := Decode([]byte{1, 0}); err == nil {
		t.Fatal("expected error on truncated header")
	}
}

func TestVarintBounds(t *testing.T) {
	cases := map[uint32]string{0: "00", 127: "7f", 128: "8001", 300: "ac02", 0xffffffff: "ffffffff0f"}
	for value, wantHex := range cases {
		got := appendVarUint(nil, value)
		if hex.EncodeToString(got) != wantHex {
			t.Errorf("varint(%d) = %x, want %s", value, got, wantHex)
		}
		back, n, err := readVarUint(got)
		if err != nil || back != value || n != len(got) {
			t.Errorf("readVarUint(%x) = %d,%d,%v", got, back, n, err)
		}
	}
	if _, _, err := readVarUint([]byte{0x80}); err == nil {
		t.Error("expected error on truncated varint")
	}
}
