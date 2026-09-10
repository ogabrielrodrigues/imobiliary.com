package domain

import (
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// Password length bounds. The minimum follows current NIST guidance, which
// favours length over composition rules. The maximum only exists to bound the
// work argon2 is asked to do on untrusted input.
const (
	MinPasswordLength = 12
	MaxPasswordLength = 256
	MaxNameLength     = 120
	MaxEmailLength    = 254 // RFC 5321 limit on a forward path
)

// User is an account able to own templates and generate documents.
type User struct {
	ID           uuid.UUID
	Email        string
	Name         string
	PasswordHash string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	// TermsAcceptedAt and TermsVersion record that this account was shown the
	// terms and agreed to a particular version of them. Nil on accounts that
	// predate the requirement, which is the truth about them.
	TermsAcceptedAt *time.Time
	TermsVersion    string
	// PasswordChangedAt is what an access token is checked against: a token
	// minted before this instant belongs to a credential that no longer
	// exists. Nil on an account whose password has never changed.
	PasswordChangedAt *time.Time
}

// NormalizeEmail lowercases and trims an address so that lookups and the
// uniqueness constraint agree on what counts as the same account.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// ValidateRegistration checks the inputs of an account creation request. The
// password is validated here but never stored on the entity in clear text: the
// caller hashes it before building the User.
func ValidateRegistration(email, name, password string) error {
	v := &ValidationError{}
	validateEmail(v, email)
	validateName(v, name)
	validatePassword(v, password)
	return v.OrNil()
}

func validateEmail(v *ValidationError, email string) {
	switch {
	case email == "":
		v.Add("email", "is required")
	case len(email) > MaxEmailLength:
		v.Addf("email", "must be at most %d characters", MaxEmailLength)
	default:
		if _, err := mail.ParseAddress(email); err != nil {
			v.Add("email", "is not a valid email address")
		}
	}
}

func validateName(v *ValidationError, name string) {
	switch {
	case strings.TrimSpace(name) == "":
		v.Add("name", "is required")
	case utf8.RuneCountInString(name) > MaxNameLength:
		v.Addf("name", "must be at most %d characters", MaxNameLength)
	}
}

func validatePassword(v *ValidationError, password string) {
	// Length is counted in runes so that a passphrase using non-ASCII
	// characters is not credited with more length than it actually has.
	switch n := utf8.RuneCountInString(password); {
	case password == "":
		v.Add("password", "is required")
	case n < MinPasswordLength:
		v.Addf("password", "must be at least %d characters", MinPasswordLength)
	case n > MaxPasswordLength:
		v.Addf("password", "must be at most %d characters", MaxPasswordLength)
	}
}
