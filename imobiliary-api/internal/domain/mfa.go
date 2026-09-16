package domain

import (
	"time"
	"uuid"
)

// RecoveryCodeCount is how many one-time codes an enrolment hands out. Ten is
// enough to survive a lost phone more than once without becoming a list nobody
// keeps safely.
const RecoveryCodeCount = 10

// TOTPEnrollment is the second factor of an account.
//
// The secret is stored sealed, like any other personal datum, and the
// enrolment only counts once the person has proved a code from it: an
// unconfirmed enrolment that already blocked sign-in would lock out anyone who
// mistyped the setup.
type TOTPEnrollment struct {
	UserID uuid.UUID
	// Secret is the sealed shared secret, opened only to verify a code.
	Secret []byte
	// LastUsedStep is the time step of the last accepted code. A code is
	// refused a second time, so one seen over someone's shoulder or captured
	// in flight cannot be replayed inside its own window.
	LastUsedStep int64
	CreatedAt    time.Time
	ConfirmedAt  *time.Time
}

// RecoveryCode is one single-use way back in when the authenticator is gone.
// Only the hash is stored, so the list cannot be read out of the database.
type RecoveryCode struct {
	ID     uuid.UUID
	UserID uuid.UUID
	Hash   []byte
	UsedAt *time.Time
}

// MFAChallenge is the short-lived proof that a password was accepted and only
// the second factor is missing.
//
// It exists as a row rather than only as a signed token so that it can be
// spent: a challenge is good for one attempt at completing a sign-in, and a
// captured one cannot be replayed after it was used.
type MFAChallenge struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TokenHash []byte
	ExpiresAt time.Time
	CreatedAt time.Time
	UsedAt    *time.Time
}

// IsUsable reports whether the challenge can still complete a sign-in.
func (c *MFAChallenge) IsUsable(now time.Time) bool {
	return c.UsedAt == nil && now.Before(c.ExpiresAt)
}

// AdminsMustHaveTOTP states the rule the user chose: an administrator manages
// members and invitations, so the account that can do that must carry a second
// factor. A member may choose.
func AdminsMustHaveTOTP(role Role) bool { return role == RoleAdmin }
