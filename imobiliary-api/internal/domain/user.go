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

// User is a person who signs in. What they may see comes from their
// memberships, never from the account itself.
type User struct {
	ID           uuid.UUID
	Email        string
	Name         string
	PasswordHash string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	// TermsAcceptedAt and TermsVersion record that this account was shown the
	// terms and agreed to a particular version of them.
	TermsAcceptedAt *time.Time
	TermsVersion    string
	// PasswordChangedAt is what an access token is checked against: a token
	// minted before this instant belongs to a credential that no longer
	// exists. Nil on an account whose password has never changed.
	PasswordChangedAt *time.Time
	// TOTPConfirmedAt is set once the second factor has been proved working.
	// An enrolment that was started and never confirmed does not count, or a
	// mistyped setup would lock the account out.
	TOTPConfirmedAt *time.Time
}

// HasTOTP reports whether the account needs a second factor to sign in.
func (u *User) HasTOTP() bool { return u.TOTPConfirmedAt != nil }

// NormalizeEmail lowercases and trims an address so that lookups and the
// uniqueness constraint agree on what counts as the same account.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// ValidateRegistration checks the inputs of a sign-up: the account, and the
// organisation created with it.
func ValidateRegistration(email, name, password, organizationName string) error {
	v := &ValidationError{}
	ValidateEmail(v, "email", email)
	ValidateName(v, "name", name)
	ValidatePassword(v, "password", password)
	ValidateOrganizationName(v, "organization_name", organizationName)
	return v.OrNil()
}

// ValidateEmail checks an address.
func ValidateEmail(v *ValidationError, field, email string) {
	switch {
	case email == "":
		v.Add(field, "is required")
	case len(email) > MaxEmailLength:
		v.Addf(field, "must be at most %d characters", MaxEmailLength)
	default:
		if _, err := mail.ParseAddress(email); err != nil {
			v.Add(field, "is not a valid email address")
		}
	}
}

// ValidateName checks a person's name.
func ValidateName(v *ValidationError, field, name string) {
	switch {
	case strings.TrimSpace(name) == "":
		v.Add(field, "is required")
	case utf8.RuneCountInString(name) > MaxNameLength:
		v.Addf(field, "must be at most %d characters", MaxNameLength)
	}
}

// ValidatePassword checks a password's length.
func ValidatePassword(v *ValidationError, field, password string) {
	// Length is counted in runes so that a passphrase using non-ASCII
	// characters is not credited with more length than it actually has.
	switch n := utf8.RuneCountInString(password); {
	case password == "":
		v.Add(field, "is required")
	case n < MinPasswordLength:
		v.Addf(field, "must be at least %d characters", MinPasswordLength)
	case n > MaxPasswordLength:
		v.Addf(field, "must be at most %d characters", MaxPasswordLength)
	}
}
