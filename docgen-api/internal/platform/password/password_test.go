package password

import (
	"errors"
	"strings"
	"testing"
)

// cheapParams keep the tests fast. Cost is what makes argon2 useful in
// production and useless in a test suite.
var cheapParams = Params{
	Memory:      1024,
	Iterations:  1,
	Parallelism: 1,
	SaltLength:  16,
	KeyLength:   32,
}

func TestHashAndVerifyRoundTrip(t *testing.T) {
	const plain = "correct horse battery staple"

	encoded, err := HashWithParams(plain, cheapParams)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}
	if err := Verify(plain, encoded); err != nil {
		t.Errorf("Verify with the correct password: %v", err)
	}
}

func TestVerifyRejectsWrongPassword(t *testing.T) {
	encoded, err := HashWithParams("correct horse battery staple", cheapParams)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}

	if err := Verify("incorrect horse battery staple", encoded); !errors.Is(err, ErrMismatch) {
		t.Errorf("Verify with a wrong password = %v, want ErrMismatch", err)
	}
}

// TestHashIsSaltedPerCall guards the property that makes precomputed tables
// useless: the same password must never produce the same stored value twice.
func TestHashIsSaltedPerCall(t *testing.T) {
	const plain = "the same password"

	first, err := HashWithParams(plain, cheapParams)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}
	second, err := HashWithParams(plain, cheapParams)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}

	if first == second {
		t.Error("hashing the same password twice produced identical output")
	}
	if err := Verify(plain, second); err != nil {
		t.Errorf("Verify against the second hash: %v", err)
	}
}

// TestHashRecordsItsParameters is what allows the cost to be raised later
// without invalidating hashes already in the database.
func TestHashRecordsItsParameters(t *testing.T) {
	encoded, err := HashWithParams("a password", cheapParams)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}

	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=1024,t=1,p=1$") {
		t.Errorf("encoded hash does not carry its parameters: %q", encoded)
	}

	// A hash produced with one cost must still verify after the default cost
	// changes, because verification reads the parameters from the hash itself.
	stronger := cheapParams
	stronger.Iterations = 2
	other, err := HashWithParams("a password", stronger)
	if err != nil {
		t.Fatalf("HashWithParams: %v", err)
	}
	if err := Verify("a password", other); err != nil {
		t.Errorf("Verify against a hash with different parameters: %v", err)
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	tests := []struct {
		name    string
		encoded string
	}{
		{"empty", ""},
		{"not a phc string", "plaintext"},
		{"wrong algorithm", "$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaA"},
		{"missing fields", "$argon2id$v=19$m=1024,t=1,p=1"},
		{"bad salt encoding", "$argon2id$v=19$m=1024,t=1,p=1$!!!not-base64!!!$aGFzaA"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := Verify("a password", tc.encoded)
			if err == nil {
				t.Fatal("Verify accepted a malformed hash")
			}
			// A malformed stored value is a corruption problem, not a wrong
			// password, and must not be reported as one.
			if errors.Is(err, ErrMismatch) {
				t.Errorf("Verify reported ErrMismatch for a malformed hash: %v", err)
			}
		})
	}
}

func TestHasherUsesDefaultParams(t *testing.T) {
	if testing.Short() {
		t.Skip("argon2 at production cost is slow")
	}

	hasher := NewHasher()
	encoded, err := hasher.Hash("a password for the default hasher")
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if err := hasher.Verify("a password for the default hasher", encoded); err != nil {
		t.Errorf("Verify: %v", err)
	}
	if err := hasher.Verify("a different password", encoded); !errors.Is(err, ErrMismatch) {
		t.Errorf("Verify with a wrong password = %v, want ErrMismatch", err)
	}
}
