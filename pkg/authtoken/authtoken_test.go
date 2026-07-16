package authtoken

import (
	"errors"
	"strings"
	"testing"
	"time"

	"atelier.dev/pkg/wire"
)

var secret = []byte("test-secret-0123456789abcdef")

func claims(exp time.Time) Claims {
	return Claims{
		Room:      "demo",
		User:      wire.UserInfo{ID: "u1", Name: "alice", Color: "#ff0000"},
		Role:      "",
		IssuedAt:  time.Now().Unix(),
		ExpiresAt: exp.Unix(),
	}
}

func TestRoundtrip(t *testing.T) {
	tok, err := Mint(secret, claims(time.Now().Add(time.Minute)))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(secret, tok, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Room != "demo" || got.User.ID != "u1" || got.User.Name != "alice" {
		t.Fatalf("claims mismatch: %+v", got)
	}
}

func TestExpired(t *testing.T) {
	tok, _ := Mint(secret, claims(time.Now().Add(-time.Second)))
	if _, err := Verify(secret, tok, time.Now()); !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

func TestTamperedPayload(t *testing.T) {
	tok, _ := Mint(secret, claims(time.Now().Add(time.Minute)))
	body, sig, _ := strings.Cut(tok, ".")
	// Flip a byte in the payload, keep the signature.
	mutated := []byte(body)
	mutated[3] ^= 1
	if _, err := Verify(secret, string(mutated)+"."+sig, time.Now()); !errors.Is(err, ErrInvalid) {
		t.Fatalf("want ErrInvalid, got %v", err)
	}
}

func TestWrongSecret(t *testing.T) {
	tok, _ := Mint(secret, claims(time.Now().Add(time.Minute)))
	other := []byte("another-secret-0123456789abcdef")
	if _, err := Verify(other, tok, time.Now()); !errors.Is(err, ErrInvalid) {
		t.Fatalf("want ErrInvalid, got %v", err)
	}
}

func TestMalformed(t *testing.T) {
	for _, tok := range []string{"", "nodot", ".", "a.", ".b", "!!!.???", "YQ.YQ"} {
		if _, err := Verify(secret, tok, time.Now()); err == nil {
			t.Fatalf("accepted malformed token %q", tok)
		}
	}
}

func TestGuards(t *testing.T) {
	if _, err := Mint([]byte("short"), claims(time.Now().Add(time.Minute))); !errors.Is(err, ErrWeakSecret) {
		t.Fatalf("want ErrWeakSecret, got %v", err)
	}
	c := claims(time.Now())
	c.ExpiresAt = 0
	if _, err := Mint(secret, c); !errors.Is(err, ErrNoExpiry) {
		t.Fatalf("want ErrNoExpiry, got %v", err)
	}
}
