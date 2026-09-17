// Package token verifies the tokens the Imobiliary platform issues for this
// service (PLANO-FASE-7.md §4). Identity lives there: this service signs
// nothing and holds no secret, only the public keys it verifies with.
package token

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"uuid"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken covers every reason a token was not accepted. The reason
// itself is deliberately not reported to the client, which would only help an
// attacker tell "expired" from "badly signed".
var ErrInvalidToken = errors.New("token: invalid access token")

// Issuer is the platform that signs the tokens, and Audience is this service.
// Both are checked: a token the platform minted for itself is refused here.
const (
	Issuer   = "imobiliary"
	Audience = "docgen"
)

// Claims are what a token for this service carries.
type Claims struct {
	jwt.RegisteredClaims
	Organization     string `json:"org"`
	OrganizationName string `json:"org_name"`
	Email            string `json:"email"`
	Name             string `json:"name"`
	Role             string `json:"role"`
}

// Identity is who a verified token speaks for.
type Identity struct {
	UserID           uuid.UUID
	OrganizationID   uuid.UUID
	OrganizationName string
	Email            string
	Name             string
	Role             string
}

// Verifier checks tokens against the platform's public keys, by name.
type Verifier struct {
	keys   map[string]ed25519.PublicKey
	parser *jwt.Parser
	now    func() time.Time
}

// Option customises a Verifier.
type Option func(*Verifier)

// WithClock replaces the time source, letting tests exercise expiry without
// sleeping.
func WithClock(now func() time.Time) Option {
	return func(v *Verifier) { v.now = now }
}

// NewVerifier returns a Verifier for the named public keys.
func NewVerifier(keys map[string]ed25519.PublicKey, opts ...Option) (*Verifier, error) {
	if len(keys) == 0 {
		return nil, errors.New("token: at least one public key is required")
	}
	v := &Verifier{keys: keys, now: time.Now}
	for _, opt := range opts {
		opt(v)
	}
	v.parser = jwt.NewParser(
		// Pinning the algorithm is what defeats a token re-signed as "none",
		// or as HMAC with the public key used as the secret.
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(Audience),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return v.now() }),
	)
	return v, nil
}

// Verify validates a raw token and reads who it speaks for.
func (v *Verifier) Verify(raw string) (*Identity, error) {
	var claims Claims
	_, err := v.parser.ParseWithClaims(raw, &claims, func(t *jwt.Token) (any, error) {
		id, _ := t.Header["kid"].(string)
		key, ok := v.keys[id]
		if !ok {
			return nil, fmt.Errorf("unknown key %q", id)
		}
		return key, nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil, fmt.Errorf("%w: subject is not a uuid", ErrInvalidToken)
	}
	orgID, err := uuid.Parse(claims.Organization)
	if err != nil {
		return nil, fmt.Errorf("%w: org is not a uuid", ErrInvalidToken)
	}
	if strings.TrimSpace(claims.Email) == "" {
		return nil, fmt.Errorf("%w: no e-mail", ErrInvalidToken)
	}
	return &Identity{
		UserID: userID, OrganizationID: orgID, OrganizationName: claims.OrganizationName,
		Email: strings.ToLower(strings.TrimSpace(claims.Email)), Name: claims.Name, Role: claims.Role,
	}, nil
}

// ParsePublicKeys reads "name:base64,name:base64", the form the platform's
// `imobiliary public-keys` prints.
func ParsePublicKeys(spec string) (map[string]ed25519.PublicKey, error) {
	keys := map[string]ed25519.PublicKey{}
	for entry := range strings.SplitSeq(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, raw, named := strings.Cut(entry, ":")
		if !named || name == "" {
			return nil, fmt.Errorf("token: %q is not name:base64", entry)
		}
		if _, dup := keys[name]; dup {
			return nil, fmt.Errorf("token: key %q appears twice", name)
		}
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil || len(b) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("token: key %q must be the base64 of %d bytes", name, ed25519.PublicKeySize)
		}
		keys[name] = ed25519.PublicKey(b)
	}
	if len(keys) == 0 {
		return nil, errors.New("token: at least one public key is required")
	}
	return keys, nil
}
