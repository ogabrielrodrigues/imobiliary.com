package token

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
	"uuid"

	"github.com/golang-jwt/jwt/v5"
)

func seed(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, KeySize)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func newSigner(t *testing.T, keys map[string][]byte, current string, opts ...Option) *Signer {
	t.Helper()
	s, err := NewSigner(keys, current, 15*time.Minute, opts...)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestIssueAndParse(t *testing.T) {
	s := newSigner(t, map[string][]byte{"1": seed(t)}, "1")
	user, org := uuid.NewV7(), uuid.NewV7()

	raw, expiresAt, err := s.IssueAccess(user, org)
	if err != nil {
		t.Fatal(err)
	}
	if time.Until(expiresAt) > 16*time.Minute || time.Until(expiresAt) < 14*time.Minute {
		t.Fatalf("the token expires at %s", expiresAt)
	}

	access, err := s.ParseAccess(raw)
	if err != nil {
		t.Fatal(err)
	}
	if access.UserID != user || access.OrganizationID != org {
		t.Fatalf("parsed %v / %v, want %v / %v", access.UserID, access.OrganizationID, user, org)
	}
	if time.Since(access.IssuedAt) > time.Minute {
		t.Fatalf("issued at %s", access.IssuedAt)
	}
}

func TestParseRefusesWhatItShould(t *testing.T) {
	s := newSigner(t, map[string][]byte{"1": seed(t)}, "1")
	other := newSigner(t, map[string][]byte{"1": seed(t)}, "1")
	raw, _, err := s.IssueAccess(uuid.NewV7(), uuid.NewV7())
	if err != nil {
		t.Fatal(err)
	}

	// Signed by another deployment's key.
	if _, err := other.ParseAccess(raw); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("a token signed with another key was accepted: %v", err)
	}
	// Tampered.
	if _, err := s.ParseAccess(raw[:len(raw)-2] + "xy"); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("a tampered token was accepted: %v", err)
	}
	for _, bad := range []string{"", "not.a.token", strings.ReplaceAll(raw, ".", "")} {
		if _, err := s.ParseAccess(bad); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("ParseAccess accepted %q", bad)
		}
	}

	// Expired: the same signer, told it is an hour later.
	late := newSigner(t, map[string][]byte{"1": seed(t)}, "1")
	rawLate, _, err := late.IssueAccess(uuid.NewV7(), uuid.NewV7())
	if err != nil {
		t.Fatal(err)
	}
	late.now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := late.ParseAccess(rawLate); !errors.Is(err, ErrInvalidToken) {
		t.Error("an expired token was accepted")
	}
}

// The classic algorithm-confusion attack: a token re-signed as "none", and one
// re-signed with HMAC using the public key as the secret. Both must fail, and
// both do because the parser pins EdDSA.
func TestParseRefusesAlgorithmConfusion(t *testing.T) {
	key := seed(t)
	s := newSigner(t, map[string][]byte{"1": key}, "1")
	public := ed25519.NewKeyFromSeed(key).Public().(ed25519.PublicKey)

	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Subject:   uuid.NewV7().String(),
			Audience:  jwt.ClaimStrings{AudienceAPI},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Organization: uuid.NewV7().String(),
	}

	none := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	none.Header["kid"] = "1"
	rawNone, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ParseAccess(rawNone); !errors.Is(err, ErrInvalidToken) {
		t.Error("an unsigned token was accepted")
	}

	hmacToken := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	hmacToken.Header["kid"] = "1"
	rawHMAC, err := hmacToken.SignedString([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ParseAccess(rawHMAC); !errors.Is(err, ErrInvalidToken) {
		t.Error("a token re-signed with the public key as an HMAC secret was accepted")
	}
}

func TestRotation(t *testing.T) {
	oldKey, newKey := seed(t), seed(t)
	before := newSigner(t, map[string][]byte{"1": oldKey}, "1")
	raw, _, err := before.IssueAccess(uuid.NewV7(), uuid.NewV7())
	if err != nil {
		t.Fatal(err)
	}

	after := newSigner(t, map[string][]byte{"1": oldKey, "2": newKey}, "2")
	if _, err := after.ParseAccess(raw); err != nil {
		t.Fatalf("a token signed before rotation stopped working: %v", err)
	}
	fresh, _, err := after.IssueAccess(uuid.NewV7(), uuid.NewV7())
	if err != nil {
		t.Fatal(err)
	}

	retired := newSigner(t, map[string][]byte{"2": newKey}, "2")
	if _, err := retired.ParseAccess(raw); !errors.Is(err, ErrInvalidToken) {
		t.Error("a retired key still verifies")
	}
	if _, err := retired.ParseAccess(fresh); err != nil {
		t.Errorf("the current key does not verify its own token: %v", err)
	}
	if len(after.PublicKeys()) != 2 {
		t.Error("PublicKeys does not report every verification key")
	}
}

func TestParseKeys(t *testing.T) {
	a := base64.StdEncoding.EncodeToString(seed(t))
	b := base64.StdEncoding.EncodeToString(seed(t))

	keys, current, err := ParseKeys("1:" + a + ",2:" + b)
	if err != nil || len(keys) != 2 || current != "2" {
		t.Fatalf("ParseKeys = %d keys, current %q, %v", len(keys), current, err)
	}
	// A bare key is named "1", so a first deployment need not know about
	// rotation.
	bare, current, err := ParseKeys(a)
	if err != nil || len(bare) != 1 || current != "1" {
		t.Fatalf("a bare key = %d keys, current %q, %v", len(bare), current, err)
	}

	for name, spec := range map[string]string{
		"empty":      "",
		"short":      "1:" + base64.StdEncoding.EncodeToString([]byte("short")),
		"not base64": "1:!!!",
		"duplicate":  "1:" + a + ",1:" + b,
		"no name":    ":" + a,
	} {
		if _, _, err := ParseKeys(spec); err == nil {
			t.Errorf("%s: ParseKeys accepted %q", name, spec)
		}
	}

	if _, err := NewSigner(map[string][]byte{"1": seed(t)}, "2", time.Minute); err == nil {
		t.Error("NewSigner accepted a current key that does not exist")
	}
}

func TestSecrets(t *testing.T) {
	first, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two secrets came out the same")
	}
	if strings.ContainsAny(first, "+/=") {
		t.Errorf("the secret %q is not URL-safe", first)
	}
	if len(HashSecret(first)) != 32 || string(HashSecret(first)) == first {
		t.Error("the stored digest is wrong")
	}
	if string(HashSecret(first)) == string(HashSecret(second)) {
		t.Error("two secrets hash the same")
	}
}
