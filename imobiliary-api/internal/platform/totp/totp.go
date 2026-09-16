// Package totp implements the time-based one-time passwords of RFC 6238, and
// the single-use recovery codes that stand in when the authenticator is gone.
//
// It is about a hundred lines of standard library: HMAC-SHA1 over a counter,
// truncated as RFC 4226 describes. Every authenticator app implements the same
// thing, and a dependency for it would be a dependency to audit.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// The parameters every authenticator app defaults to. They are not
// configurable: a code that an app cannot produce is worse than no second
// factor at all.
const (
	// Period is how long one code lasts.
	Period = 30 * time.Second
	// Digits is the length of a code.
	Digits = 6
	// secretBytes is the shared secret's length. RFC 4226 asks for at least
	// 128 bits and recommends 160, which is what this is.
	secretBytes = 20
	// Skew is how many steps either side of now are accepted, for clocks that
	// disagree and for a code typed as it expires.
	Skew = 1
)

// ErrInvalidSecret is reported for a secret that is not the base32 this
// package produces.
var ErrInvalidSecret = errors.New("totp: invalid secret")

// encoding is base32 without padding, which is what authenticator apps read.
var encoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewSecret returns a fresh shared secret, in the base32 an app expects.
func NewSecret() (string, error) {
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("totp: read random bytes: %w", err)
	}
	return encoding.EncodeToString(buf), nil
}

// URI is the otpauth:// address behind the QR code an app scans.
//
// The label carries the account so that someone with several accounts can tell
// them apart in the app's list.
func URI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	query := url.Values{
		"secret":    {secret},
		"issuer":    {issuer},
		"digits":    {fmt.Sprint(Digits)},
		"period":    {fmt.Sprint(int(Period.Seconds()))},
		"algorithm": {"SHA1"},
	}
	return "otpauth://totp/" + label + "?" + query.Encode()
}

// Step is the counter a moment falls in. It is stored with the enrolment so
// that a code cannot be used twice.
func Step(at time.Time) int64 {
	return at.Unix() / int64(Period.Seconds())
}

// Code is the password for one step.
func Code(secret string, step int64) (string, error) {
	key, err := encoding.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(key) == 0 {
		return "", ErrInvalidSecret
	}

	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))

	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)

	// RFC 4226 dynamic truncation: the low nibble of the last byte picks where
	// to read four bytes, whose low 31 bits become the number.
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff

	mod := uint32(1)
	for range Digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", Digits, value%mod), nil
}

// Verify checks a code against the secret and reports the step it belongs to.
//
// lastUsedStep is the step of the last code this account accepted: a step at
// or below it is refused, so a code seen over a shoulder or captured in flight
// cannot be replayed while it is still inside its own window. The caller
// stores the step it gets back.
func Verify(secret, code string, now time.Time, lastUsedStep int64) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != Digits {
		return 0, false
	}

	current := Step(now)
	for offset := -Skew; offset <= Skew; offset++ {
		step := current + int64(offset)
		if step <= lastUsedStep {
			continue
		}
		expected, err := Code(secret, step)
		if err != nil {
			return 0, false
		}
		// Constant time: a comparison that returns early leaks how much of a
		// guessed code was right.
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// RecoveryCodeLength is how many characters a recovery code has, without its
// separator. Ten base32 characters carry 50 bits, which is far beyond guessing
// against a rate-limited endpoint.
const RecoveryCodeLength = 10

// NewRecoveryCodes returns n codes, in the form shown to the person, and is
// the only moment they exist in the clear.
func NewRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, 0, n)
	for range n {
		buf := make([]byte, 7) // 56 bits, of which 50 are used
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("totp: read random bytes: %w", err)
		}
		code := encoding.EncodeToString(buf)[:RecoveryCodeLength]
		// Split in the middle, the way every service that hands these out
		// does, because they are copied by hand.
		codes = append(codes, code[:5]+"-"+code[5:])
	}
	return codes, nil
}

// NormalizeRecoveryCode makes a typed code comparable: upper case, without the
// separator or spaces.
func NormalizeRecoveryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	return strings.NewReplacer("-", "", " ", "").Replace(code)
}

// HashRecoveryCode derives what is stored. A recovery code carries 50 bits of
// randomness, so a plain digest is enough: there is no pre-image to guess.
func HashRecoveryCode(code string) []byte {
	sum := sha256.Sum256([]byte(NormalizeRecoveryCode(code)))
	return sum[:]
}
