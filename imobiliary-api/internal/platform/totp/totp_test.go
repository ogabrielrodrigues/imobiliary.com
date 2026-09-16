package totp

import (
	"strings"
	"testing"
	"time"
)

// The secret of RFC 6238's test vectors, "12345678901234567890", in base32.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestCodeMatchesRFC6238(t *testing.T) {
	// The RFC prints eight digits; six is what apps show, so the last six of
	// each vector are what this must produce.
	vectors := map[int64]string{
		59:          "287082",
		1111111109:  "081804",
		1111111111:  "050471",
		1234567890:  "005924",
		2000000000:  "279037",
		20000000000: "353130",
	}
	for seconds, want := range vectors {
		at := time.Unix(seconds, 0).UTC()
		got, err := Code(rfcSecret, Step(at))
		if err != nil || got != want {
			t.Errorf("Code at %s = %q, %v; want %q", at, got, err, want)
		}
	}
}

func TestVerifyAcceptsTheWindowAndRefusesReplay(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	current := Step(now)

	code, err := Code(rfcSecret, current)
	if err != nil {
		t.Fatal(err)
	}
	step, ok := Verify(rfcSecret, code, now, 0)
	if !ok || step != current {
		t.Fatalf("a current code was refused: step %d, ok %v", step, ok)
	}

	// The same code again, with the step recorded, is refused: this is what
	// stops a code captured in flight from being used inside its own window.
	if _, ok := Verify(rfcSecret, code, now, step); ok {
		t.Fatal("a code was accepted twice")
	}

	// One step either side is accepted, for clocks that disagree.
	for _, offset := range []int64{-1, 1} {
		neighbour, err := Code(rfcSecret, current+offset)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := Verify(rfcSecret, neighbour, now, 0); !ok {
			t.Errorf("the code %d step away was refused", offset)
		}
	}

	// Two steps away is not.
	far, err := Code(rfcSecret, current+2)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := Verify(rfcSecret, far, now, 0); ok {
		t.Error("a code two steps away was accepted")
	}

	for _, bad := range []string{"", "12345", "1234567", "abcdef", code + " "} {
		if _, ok := Verify(rfcSecret, bad, now, 0); ok && strings.TrimSpace(bad) != code {
			t.Errorf("Verify accepted %q", bad)
		}
	}
	if _, ok := Verify("not base32!", code, now, 0); ok {
		t.Error("Verify accepted an invalid secret")
	}
}

func TestSecretAndURI(t *testing.T) {
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Code(secret, Step(time.Now())); err != nil {
		t.Fatalf("a generated secret does not produce codes: %v", err)
	}
	if strings.Contains(secret, "=") {
		t.Error("the secret is padded; authenticator apps read it unpadded")
	}

	// "@" is legal in a path segment, so PathEscape leaves it alone and the
	// label reads as an authenticator app shows it.
	uri := URI("Imobiliary", "ana@example.com", secret)
	for _, part := range []string{"otpauth://totp/", "secret=" + secret, "issuer=Imobiliary", "digits=6", "period=30", "Imobiliary:ana@example.com"} {
		if !strings.Contains(uri, part) {
			t.Errorf("the otpauth URI lacks %q: %s", part, uri)
		}
	}
}

func TestRecoveryCodes(t *testing.T) {
	codes, err := NewRecoveryCodes(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 10 {
		t.Fatalf("got %d codes", len(codes))
	}

	seen := map[string]bool{}
	for _, code := range codes {
		if len(code) != RecoveryCodeLength+1 || !strings.Contains(code, "-") {
			t.Errorf("code %q is not shaped for copying by hand", code)
		}
		if seen[code] {
			t.Errorf("code %q was generated twice", code)
		}
		seen[code] = true
	}

	// A code is recognised however it was typed back.
	code := codes[0]
	hash := HashRecoveryCode(code)
	for _, typed := range []string{code, strings.ToLower(code), strings.ReplaceAll(code, "-", ""), " " + code + " "} {
		if string(HashRecoveryCode(typed)) != string(hash) {
			t.Errorf("%q does not hash to the stored code", typed)
		}
	}
	if string(HashRecoveryCode(codes[1])) == string(hash) {
		t.Error("two codes hash the same")
	}
}
