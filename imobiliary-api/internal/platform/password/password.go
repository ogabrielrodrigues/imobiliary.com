// Package password hashes and verifies user passwords with argon2id.
//
// The standard library has no password KDF, which is why golang.org/x/crypto is
// one of this module's three dependencies. It is maintained by the Go team
// itself, so the trust boundary is effectively the same as the standard
// library's.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// ErrMismatch is returned when a password does not match the stored hash.
var ErrMismatch = errors.New("password: mismatch")

// Params are the argon2id cost parameters.
type Params struct {
	Memory      uint32 // KiB
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultParams follows the OWASP baseline of m=19456 KiB, t=2, p=1.
//
// The memory cost is deliberately not set higher. Every concurrent login holds
// its full working set at once, so a generous setting turns the login endpoint
// into a memory-exhaustion vector. 19 MiB paired with the strict per-IP limit
// on the auth routes keeps the worst case bounded while staying well above the
// cost of a GPU-friendly hash.
var DefaultParams = Params{
	Memory:      19 * 1024,
	Iterations:  2,
	Parallelism: 1,
	SaltLength:  16,
	KeyLength:   32,
}

// Hash derives an encoded argon2id hash for the password.
//
// The result is a PHC-style string that carries the parameters and salt
// alongside the digest, so cost settings can be raised later without
// invalidating hashes already stored.
func Hash(plain string) (string, error) {
	return HashWithParams(plain, DefaultParams)
}

// HashWithParams is Hash with explicit cost parameters. Tests use it to keep
// the work factor low.
func HashWithParams(plain string, p Params) (string, error) {
	salt := make([]byte, p.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(plain), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLength)

	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify reports whether plain matches the encoded hash, returning ErrMismatch
// when it does not.
func Verify(plain, encoded string) error {
	p, salt, want, err := decode(encoded)
	if err != nil {
		return err
	}
	got := argon2.IDKey([]byte(plain), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLength)

	// Constant-time comparison: a timing-sensitive check here would leak how
	// many leading bytes of a guess were correct.
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}

func decode(encoded string) (p Params, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return p, nil, nil, errors.New("password: malformed hash")
	}

	var version int
	if _, err = fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return p, nil, nil, fmt.Errorf("password: read version: %w", err)
	}
	if version != argon2.Version {
		return p, nil, nil, fmt.Errorf("password: unsupported argon2 version %d", version)
	}
	if _, err = fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &p.Parallelism); err != nil {
		return p, nil, nil, fmt.Errorf("password: read parameters: %w", err)
	}
	if salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil {
		return p, nil, nil, fmt.Errorf("password: decode salt: %w", err)
	}
	if key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil {
		return p, nil, nil, fmt.Errorf("password: decode key: %w", err)
	}

	p.SaltLength = uint32(len(salt))
	p.KeyLength = uint32(len(key))
	return p, salt, key, nil
}

// Hasher adapts this package's functions to the small interface the use case
// layer declares, so that layer depends on a behaviour rather than on argon2.
type Hasher struct {
	params Params
	// slots bounds how many derivations run at once across the process.
	slots chan struct{}
}

// MaxConcurrentHashes caps simultaneous derivations.
//
// Each one holds DefaultParams.Memory (19 MiB) for its duration. The per-IP
// limit on the credential endpoints bounds one client, not many: a flood
// from enough addresses would otherwise hold that much memory per request
// until the process is killed. Eight keeps the worst case near 152 MiB; the
// ninth caller waits for a slot instead of allocating its own.
const MaxConcurrentHashes = 8

// NewHasher returns a Hasher using DefaultParams.
func NewHasher() *Hasher {
	return &Hasher{params: DefaultParams, slots: make(chan struct{}, MaxConcurrentHashes)}
}

// Hash derives an encoded hash for the password.
func (h *Hasher) Hash(plain string) (string, error) {
	h.acquire()
	defer h.release()
	return HashWithParams(plain, h.params)
}

// Verify reports whether plain matches the encoded hash.
//
// It goes through the same slots as Hash, and that includes the dummy
// verification Login runs for unknown addresses: those cost exactly as
// much memory as real ones, which is the point of them.
func (h *Hasher) Verify(plain, encoded string) error {
	h.acquire()
	defer h.release()
	return Verify(plain, encoded)
}

func (h *Hasher) acquire() { h.slots <- struct{}{} }
func (h *Hasher) release() { <-h.slots }
