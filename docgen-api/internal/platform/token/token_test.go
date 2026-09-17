package token

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"
	"uuid"

	"github.com/golang-jwt/jwt/v5"
)

func keyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func sign(t *testing.T, priv ed25519.PrivateKey, kid string, claims Claims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = kid
	raw, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func validClaims() Claims {
	now := time.Now()
	return Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: Issuer, Subject: uuid.NewV7().String(), Audience: jwt.ClaimStrings{Audience},
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
		Organization: uuid.NewV7().String(), OrganizationName: "Central",
		Email: " Ana@Example.com ", Name: "Ana", Role: "admin",
	}
}

func TestVerify(t *testing.T) {
	pub, priv := keyPair(t)
	v, err := NewVerifier(map[string]ed25519.PublicKey{"1": pub})
	if err != nil {
		t.Fatal(err)
	}
	claims := validClaims()
	id, err := v.Verify(sign(t, priv, "1", claims))
	if err != nil {
		t.Fatal(err)
	}
	if id.Email != "ana@example.com" || id.OrganizationName != "Central" || id.Role != "admin" ||
		id.OrganizationID.String() != claims.Organization {
		t.Errorf("identity %+v", id)
	}
}

func TestVerifyRefuses(t *testing.T) {
	pub, priv := keyPair(t)
	_, otherPriv := keyPair(t)
	v, _ := NewVerifier(map[string]ed25519.PublicKey{"1": pub})

	cases := map[string]string{}
	cases["another key"] = sign(t, otherPriv, "1", validClaims())
	cases["unknown kid"] = sign(t, priv, "2", validClaims())

	wrongAudience := validClaims()
	wrongAudience.Audience = jwt.ClaimStrings{"imobiliary-api"}
	cases["the platform's own audience"] = sign(t, priv, "1", wrongAudience)

	wrongIssuer := validClaims()
	wrongIssuer.Issuer = "docgen"
	cases["another issuer"] = sign(t, priv, "1", wrongIssuer)

	expired := validClaims()
	expired.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
	cases["expired"] = sign(t, priv, "1", expired)

	noEmail := validClaims()
	noEmail.Email = ""
	cases["no e-mail"] = sign(t, priv, "1", noEmail)

	// An HMAC token keyed with the public key: the classic confusion attack.
	hmac := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims())
	hmac.Header["kid"] = "1"
	raw, _ := hmac.SignedString([]byte(pub))
	cases["HS256 with the public key"] = raw

	for name, raw := range cases {
		if _, err := v.Verify(raw); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
}

func TestParsePublicKeys(t *testing.T) {
	pub, _ := keyPair(t)
	keys, err := ParsePublicKeys("1:" + base64.StdEncoding.EncodeToString(pub))
	if err != nil || len(keys) != 1 {
		t.Fatalf("keys %v, %v", keys, err)
	}
	for _, bad := range []string{"", "abc", "1:bm90LWEta2V5", "1:" + base64.StdEncoding.EncodeToString(pub) + ",1:" + base64.StdEncoding.EncodeToString(pub)} {
		if _, err := ParsePublicKeys(bad); err == nil {
			t.Errorf("ParsePublicKeys(%q) accepted", bad)
		}
	}
}
