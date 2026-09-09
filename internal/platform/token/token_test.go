package token

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
	"uuid"
)

var testSecret = []byte("a-test-secret-of-at-least-32-bytes!!")

// clockAt returns a fixed time source, so expiry can be tested by moving the
// clock rather than by waiting.
func clockAt(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

func TestIssueAndParseAccessRoundTrip(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	issuer := NewIssuer(testSecret, 15*time.Minute, WithClock(clockAt(now)))
	userID := uuid.NewV7()

	raw, expiresAt, err := issuer.IssueAccess(userID)
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}
	if want := now.Add(15 * time.Minute); !expiresAt.Equal(want) {
		t.Errorf("expiry = %v, want %v", expiresAt, want)
	}

	got, err := issuer.ParseAccess(raw)
	if err != nil {
		t.Fatalf("ParseAccess: %v", err)
	}
	if got != userID {
		t.Errorf("ParseAccess returned %s, want %s", got, userID)
	}
}

func TestParseAccessRejectsExpiredToken(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	current := now
	issuer := NewIssuer(testSecret, 15*time.Minute, WithClock(func() time.Time { return current }))

	raw, _, err := issuer.IssueAccess(uuid.NewV7())
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}

	current = now.Add(16 * time.Minute)
	if _, err := issuer.ParseAccess(raw); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("ParseAccess on an expired token = %v, want ErrInvalidToken", err)
	}
}

func TestParseAccessRejectsForeignSignature(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	mint := NewIssuer([]byte("a-different-secret-of-32-bytes!!!!!!"), time.Hour, WithClock(clockAt(now)))
	verify := NewIssuer(testSecret, time.Hour, WithClock(clockAt(now)))

	raw, _, err := mint.IssueAccess(uuid.NewV7())
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}

	if _, err := verify.ParseAccess(raw); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("ParseAccess with the wrong key = %v, want ErrInvalidToken", err)
	}
}

// TestParseAccessRejectsUnsignedToken covers the classic algorithm confusion
// attack: re-encoding a token with "alg":"none" and dropping the signature. It
// must be refused because the parser pins HS256.
func TestParseAccessRejectsUnsignedToken(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	issuer := NewIssuer(testSecret, time.Hour, WithClock(clockAt(now)))

	raw, _, err := issuer.IssueAccess(uuid.NewV7())
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}

	encode := base64.RawURLEncoding.EncodeToString
	forged := encode([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + parts[1] + "."

	if _, err := issuer.ParseAccess(forged); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("ParseAccess on an unsigned token = %v, want ErrInvalidToken", err)
	}
}

func TestParseAccessRejectsGarbage(t *testing.T) {
	issuer := NewIssuer(testSecret, time.Hour)

	for _, raw := range []string{"", "not-a-token", "a.b.c", strings.Repeat("x", 500)} {
		if _, err := issuer.ParseAccess(raw); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("ParseAccess(%q) = %v, want ErrInvalidToken", raw, err)
		}
	}
}

func TestNewRefreshSecretIsUniqueAndOpaque(t *testing.T) {
	seen := make(map[string]struct{}, 100)

	for range 100 {
		secret, err := NewRefreshSecret()
		if err != nil {
			t.Fatalf("NewRefreshSecret: %v", err)
		}
		if _, duplicate := seen[secret]; duplicate {
			t.Fatal("NewRefreshSecret produced a duplicate")
		}
		seen[secret] = struct{}{}

		// 32 random bytes in unpadded base64url.
		if len(secret) != 43 {
			t.Errorf("secret length = %d, want 43", len(secret))
		}
	}
}

func TestHashRefreshSecretIsDeterministicAndHidesInput(t *testing.T) {
	secret, err := NewRefreshSecret()
	if err != nil {
		t.Fatalf("NewRefreshSecret: %v", err)
	}

	first := HashRefreshSecret(secret)
	if len(first) != 32 {
		t.Errorf("digest length = %d, want 32", len(first))
	}
	if string(first) != string(HashRefreshSecret(secret)) {
		t.Error("hashing the same secret twice produced different digests")
	}
	if strings.Contains(string(first), secret) {
		t.Error("digest contains the secret itself")
	}

	other, err := NewRefreshSecret()
	if err != nil {
		t.Fatalf("NewRefreshSecret: %v", err)
	}
	if string(first) == string(HashRefreshSecret(other)) {
		t.Error("two different secrets hashed to the same digest")
	}
}
