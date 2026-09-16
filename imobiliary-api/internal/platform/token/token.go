// Package token issues and validates the credentials that make up a session:
// a short-lived signed access token, and the opaque secrets that travel in a
// refresh, a reset link, an invitation and an MFA challenge.
package token

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"uuid"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken covers every reason an access token was not accepted. The
// reason itself is deliberately not reported to the client, which would only
// help an attacker tell "expired" from "badly signed".
var ErrInvalidToken = errors.New("token: invalid access token")

// Issuer names this service in every token it mints and is checked on parse,
// so a token issued elsewhere is rejected even if it were somehow signed with
// the same key.
const Issuer = "imobiliary"

// AudienceAPI is this API's own audience. Another service that comes to accept
// these tokens, such as the document API, is given an audience of its own and
// verifies with the public key alone.
const AudienceAPI = "imobiliary-api"

// secretBytes gives an opaque secret 256 bits of entropy, which is what allows
// it to be stored as a plain SHA-256 digest: guessing the pre-image is
// infeasible, so the slow KDF used for passwords buys nothing here.
const secretBytes = 32

// KeySize is the length of an Ed25519 seed, which is how a signing key is
// configured.
const KeySize = ed25519.SeedSize

// Signer mints and verifies access tokens.
//
// Ed25519 rather than HMAC, which is what docgen uses. With HMAC, verifying
// and signing are the same power: handing the document API the key so it could
// verify would also let it mint tokens for this one. With a signature, the
// private key never leaves this service and anyone else verifies with the
// public half.
type Signer struct {
	keyID     string
	private   ed25519.PrivateKey
	publics   map[string]ed25519.PublicKey
	accessTTL time.Duration
	parser    *jwt.Parser
	now       func() time.Time
}

// Option customises a Signer.
type Option func(*Signer)

// WithClock replaces the time source, letting tests exercise expiry without
// sleeping.
func WithClock(now func() time.Time) Option {
	return func(s *Signer) { s.now = now }
}

// NewSigner returns a Signer that signs with the newest key and still verifies
// tokens signed with any of the others, which is what lets a key be rotated
// without invalidating every session in circulation.
func NewSigner(keys map[string][]byte, currentKeyID string, accessTTL time.Duration, opts ...Option) (*Signer, error) {
	seed, ok := keys[currentKeyID]
	if !ok {
		return nil, fmt.Errorf("token: no key named %q to sign with", currentKeyID)
	}

	s := &Signer{
		keyID:     currentKeyID,
		private:   ed25519.NewKeyFromSeed(seed),
		publics:   make(map[string]ed25519.PublicKey, len(keys)),
		accessTTL: accessTTL,
		now:       time.Now,
	}
	for id, key := range keys {
		if len(key) != KeySize {
			return nil, fmt.Errorf("token: key %q must be %d bytes", id, KeySize)
		}
		s.publics[id] = ed25519.NewKeyFromSeed(key).Public().(ed25519.PublicKey)
	}
	for _, opt := range opts {
		opt(s)
	}

	s.parser = jwt.NewParser(
		// Pinning the algorithm is what defeats the classic confusion attack,
		// where a token is re-signed as "none" or with the public key read as
		// an HMAC secret.
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(AudienceAPI),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return s.now() }),
	)
	return s, nil
}

// PublicKeys returns the verification keys by name, for the day another
// service verifies these tokens.
func (s *Signer) PublicKeys() map[string]ed25519.PublicKey {
	return maps.Clone(s.publics)
}

// Claims are what an access token carries beyond the registered fields.
type Claims struct {
	jwt.RegisteredClaims
	// Organization is the office this session is working in. It is in the
	// token so that a request names one without a round trip, and the
	// membership behind it is still checked against the database on every
	// request: a role changed a minute ago must not keep working for the rest
	// of the token's life.
	Organization string `json:"org"`
}

// Access identifies who is calling and where.
type Access struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	IssuedAt       time.Time
}

// IssueAccess mints an access token and reports when it expires.
func (s *Signer) IssueAccess(userID, organizationID uuid.UUID) (string, time.Time, error) {
	now := s.now()
	expiresAt := now.Add(s.accessTTL)

	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{AudienceAPI},
			ID:        uuid.NewV4().String(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
		Organization: organizationID.String(),
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	// The key's name travels in the header, so a verifier knows which public
	// key to use without trying each one.
	tok.Header["kid"] = s.keyID

	signed, err := tok.SignedString(s.private)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("token: sign access token: %w", err)
	}
	return signed, expiresAt, nil
}

// ParseAccess validates a raw access token.
//
// The issue time comes back because an access token is stateless: nothing can
// be revoked out from under it, so the only way to reject one minted before a
// credential changed is to compare the two instants.
func (s *Signer) ParseAccess(raw string) (Access, error) {
	var claims Claims
	_, err := s.parser.ParseWithClaims(raw, &claims, func(t *jwt.Token) (any, error) {
		id, _ := t.Header["kid"].(string)
		key, ok := s.publics[id]
		if !ok {
			return nil, fmt.Errorf("unknown key %q", id)
		}
		return key, nil
	})
	if err != nil {
		return Access{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}

	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return Access{}, fmt.Errorf("%w: subject is not a uuid", ErrInvalidToken)
	}
	organizationID, err := uuid.Parse(claims.Organization)
	if err != nil {
		return Access{}, fmt.Errorf("%w: org is not a uuid", ErrInvalidToken)
	}
	if claims.IssuedAt == nil {
		return Access{}, fmt.Errorf("%w: no issued-at claim", ErrInvalidToken)
	}
	return Access{
		UserID:         userID,
		OrganizationID: organizationID,
		IssuedAt:       claims.IssuedAt.Time.UTC(),
	}, nil
}

// NewSecret returns a fresh opaque secret, URL-safe so it can travel in a JSON
// body or a link without further encoding. It backs refresh tokens, reset
// links, invitations and MFA challenges alike.
func NewSecret() (string, error) {
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("token: read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashSecret derives the digest stored in the database. Only this value is
// persisted, so a leaked database yields no usable credential.
func HashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// ParseKeys reads signing keys written as "<name>:<base64 seed>", comma
// separated, the form they take in the environment. A single key may be
// written bare and is named "1", as the field keys are.
func ParseKeys(spec string) (map[string][]byte, string, error) {
	keys := make(map[string][]byte)
	for entry := range strings.SplitSeq(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, raw, named := strings.Cut(entry, ":")
		if !named {
			name, raw = "1", entry
		}
		if name == "" {
			return nil, "", errors.New("token: a key name must not be empty")
		}
		if _, duplicate := keys[name]; duplicate {
			return nil, "", fmt.Errorf("token: key %q appears twice", name)
		}
		seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil || len(seed) != KeySize {
			return nil, "", fmt.Errorf("token: key %q must be the base64 of %d bytes", name, KeySize)
		}
		keys[name] = seed
	}
	if len(keys) == 0 {
		return nil, "", errors.New("token: at least one signing key is required")
	}
	// The newest key signs. Names sort, so a deployment rotating keys names
	// them in order: 1, 2, 3.
	current := slices.Max(slices.Collect(maps.Keys(keys)))
	return keys, current, nil
}
