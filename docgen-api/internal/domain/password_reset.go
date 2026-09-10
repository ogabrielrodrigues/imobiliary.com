package domain

import (
	"time"
	"uuid"
)

// PasswordReset is a one-time permission to set a new password without knowing
// the old one.
//
// It is worth as much as the password itself, so only the digest of the secret
// is ever persisted — the same treatment a refresh token gets, for the same
// reason: a leak of the table must hand out nothing usable.
type PasswordReset struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TokenHash []byte
	ExpiresAt time.Time
	CreatedAt time.Time
	UsedAt    *time.Time
}

// IsUsable reports whether the token may still be exchanged.
func (p *PasswordReset) IsUsable(now time.Time) bool {
	return p.UsedAt == nil && now.Before(p.ExpiresAt)
}

// ValidatePasswordChange checks a new password on its own.
//
// Registration validates an address and a name alongside the password;
// changing one has neither, so the rule lives here where both callers reach it
// and neither can drift from the other.
func ValidatePasswordChange(password string) error {
	v := &ValidationError{}
	validatePassword(v, password)
	return v.OrNil()
}
