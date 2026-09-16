package domain

import (
	"time"
	"uuid"
)

// Invitation is how someone joins an organisation.
//
// An admin invites an address; the link carries a secret whose hash alone is
// stored, exactly as a password reset does. Accepting it creates the account,
// or attaches an existing one, and the membership, in a single transaction.
//
// The alternative, an admin typing a password for someone else, was declined
// for the obvious reason: it means a person's first credential was known to
// somebody else.
type Invitation struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Email          string
	Role           Role
	TokenHash      []byte
	InvitedBy      uuid.UUID
	ExpiresAt      time.Time
	CreatedAt      time.Time
	AcceptedAt     *time.Time
	RevokedAt      *time.Time
}

// IsUsable reports whether the invitation can still be accepted.
func (i *Invitation) IsUsable(now time.Time) bool {
	return i.AcceptedAt == nil && i.RevokedAt == nil && now.Before(i.ExpiresAt)
}

// Status is what a list of invitations shows next to each address.
type InvitationStatus string

const (
	InvitationPending  InvitationStatus = "pending"
	InvitationAccepted InvitationStatus = "accepted"
	InvitationRevoked  InvitationStatus = "revoked"
	InvitationExpired  InvitationStatus = "expired"
)

// StatusAt reports the invitation's state at a given moment. Expiry is derived
// rather than stored: a stored status would be wrong from the instant the
// expiry passes until something ran to correct it.
func (i *Invitation) StatusAt(now time.Time) InvitationStatus {
	switch {
	case i.AcceptedAt != nil:
		return InvitationAccepted
	case i.RevokedAt != nil:
		return InvitationRevoked
	case !now.Before(i.ExpiresAt):
		return InvitationExpired
	default:
		return InvitationPending
	}
}

// ValidateInvitation checks what an admin typed.
func ValidateInvitation(email string, role Role) error {
	v := &ValidationError{}
	ValidateEmail(v, "email", email)
	ValidateRole(v, "role", role)
	return v.OrNil()
}
