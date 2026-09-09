package domain

import (
	"time"
	"uuid"
)

// RefreshToken is one link in a session chain. Each use of a refresh token
// mints a successor that points back at it through ParentID, which is what
// lets the service detect replay of an already-consumed token.
//
// Only the hash of the secret is ever persisted, so a database leak does not
// hand out usable sessions.
type RefreshToken struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TokenHash []byte
	ParentID  *uuid.UUID
	ExpiresAt time.Time
	CreatedAt time.Time
	UsedAt    *time.Time
	RevokedAt *time.Time
}

// IsUsable reports whether the token can still be exchanged at the given time.
func (t *RefreshToken) IsUsable(now time.Time) bool {
	return t.UsedAt == nil && t.RevokedAt == nil && now.Before(t.ExpiresAt)
}

// IsConsumed reports whether the token was already exchanged. Presenting a
// consumed token is the signal of a stolen session: the whole chain is revoked
// in response.
func (t *RefreshToken) IsConsumed() bool {
	return t.UsedAt != nil
}
