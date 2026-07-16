// Package authtoken implements the compact HMAC tokens core-api mints and
// the relay verifies (blueprint doc 10 §6: short-lived, audience-scoped room
// tokens, separate from API sessions).
//
// Format: base64url(claimsJSON) + "." + base64url(HMAC-SHA256(base64url(claimsJSON)))
//
// Deliberately not JWT: no algorithm negotiation (alg-confusion attacks are
// structurally impossible), no header, one hash. Production later swaps the
// shared secret for asymmetric keys behind the same Mint/Verify interface.
package authtoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"atelier.dev/pkg/wire"
)

var (
	ErrInvalid     = errors.New("authtoken: invalid token")
	ErrExpired     = errors.New("authtoken: token expired")
	ErrWeakSecret  = errors.New("authtoken: secret must be at least 16 bytes")
	ErrNoExpiry    = errors.New("authtoken: claims must set ExpiresAt")
)

// Claims carried by a token. Room is empty for session cookies.
type Claims struct {
	Room      string        `json:"room,omitempty"`
	User      wire.UserInfo `json:"user"`
	Role      string        `json:"role,omitempty"`
	IssuedAt  int64         `json:"iat"`
	ExpiresAt int64         `json:"exp"`
}

const minSecretLen = 16

var enc = base64.RawURLEncoding

// Mint signs claims into a token string.
func Mint(secret []byte, claims Claims) (string, error) {
	if len(secret) < minSecretLen {
		return "", ErrWeakSecret
	}
	if claims.ExpiresAt == 0 {
		return "", ErrNoExpiry
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("authtoken: marshal: %w", err)
	}
	body := enc.EncodeToString(payload)
	return body + "." + enc.EncodeToString(sign(secret, body)), nil
}

// Verify checks the signature and expiry, returning the claims.
func Verify(secret []byte, token string, now time.Time) (Claims, error) {
	if len(secret) < minSecretLen {
		return Claims{}, ErrWeakSecret
	}
	body, sig, ok := strings.Cut(token, ".")
	if !ok || body == "" || sig == "" {
		return Claims{}, ErrInvalid
	}
	gotSig, err := enc.DecodeString(sig)
	if err != nil {
		return Claims{}, ErrInvalid
	}
	if !hmac.Equal(gotSig, sign(secret, body)) {
		return Claims{}, ErrInvalid
	}
	payload, err := enc.DecodeString(body)
	if err != nil {
		return Claims{}, ErrInvalid
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, ErrInvalid
	}
	if claims.ExpiresAt == 0 || now.Unix() >= claims.ExpiresAt {
		return Claims{}, ErrExpired
	}
	return claims, nil
}

func sign(secret []byte, body string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(body))
	return mac.Sum(nil)
}
