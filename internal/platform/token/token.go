// Package token issues and validates the two credentials that make up a
// session: a short-lived signed access token and an opaque refresh secret.
package token

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
	"uuid"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken covers every reason an access token was not accepted. The
// reason itself is deliberately not reported to the client, which would only
// help an attacker tell "expired" from "badly signed".
var ErrInvalidToken = errors.New("token: invalid access token")

// issuerName identifies tokens minted by this service and is validated on
// parse, so a token issued elsewhere with the same key is still rejected.
const issuerName = "docgen"

// refreshSecretBytes gives a refresh secret 256 bits of entropy, which is what
// allows it to be stored as a plain SHA-256 digest: guessing the pre-image is
// infeasible, so the slow KDF used for passwords buys nothing here.
const refreshSecretBytes = 32

// Issuer mints and verifies access tokens.
type Issuer struct {
	secret    []byte
	accessTTL time.Duration
	parser    *jwt.Parser
	now       func() time.Time
}

// Option customises an Issuer.
type Option func(*Issuer)

// WithClock replaces the time source, letting tests exercise expiry without
// sleeping.
func WithClock(now func() time.Time) Option {
	return func(i *Issuer) { i.now = now }
}

// NewIssuer returns an Issuer signing with the given HMAC secret.
func NewIssuer(secret []byte, accessTTL time.Duration, opts ...Option) *Issuer {
	i := &Issuer{
		secret:    secret,
		accessTTL: accessTTL,
		now:       time.Now,
	}
	for _, opt := range opts {
		opt(i)
	}
	i.parser = jwt.NewParser(
		// Pinning the algorithm is what defeats the classic confusion attack,
		// where a token is re-signed as "none" or as RS256 using the HMAC key
		// as an RSA public key.
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuerName),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return i.now() }),
	)
	return i
}

// IssueAccess mints an access token for the user and reports when it expires.
func (i *Issuer) IssueAccess(userID uuid.UUID) (string, time.Time, error) {
	now := i.now()
	expiresAt := now.Add(i.accessTTL)

	claims := jwt.RegisteredClaims{
		Issuer:    issuerName,
		Subject:   userID.String(),
		ID:        uuid.NewV4().String(),
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(expiresAt),
	}

	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("token: sign access token: %w", err)
	}
	return signed, expiresAt, nil
}

// ParseAccess validates a raw access token and returns the user it identifies.
func (i *Issuer) ParseAccess(raw string) (uuid.UUID, error) {
	var claims jwt.RegisteredClaims
	_, err := i.parser.ParseWithClaims(raw, &claims, func(*jwt.Token) (any, error) {
		return i.secret, nil
	})
	if err != nil {
		return uuid.Nil(), fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}

	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return uuid.Nil(), fmt.Errorf("%w: subject is not a uuid", ErrInvalidToken)
	}
	return userID, nil
}

// NewRefreshSecret returns a fresh opaque refresh secret, URL-safe so it can
// travel in a JSON body without further encoding.
func NewRefreshSecret() (string, error) {
	buf := make([]byte, refreshSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("token: read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashRefreshSecret derives the digest stored in the database. Only this value
// is persisted, so a leaked database yields no usable sessions.
func HashRefreshSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}
