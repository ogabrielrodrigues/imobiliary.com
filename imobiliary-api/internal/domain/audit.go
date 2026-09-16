package domain

import (
	"net/netip"
	"time"
	"uuid"
)

// AuditAction names something that happened, in the past tense and stable
// forever: these strings are what a later audit reads, so they may be added to
// but not reworded.
type AuditAction string

const (
	ActionOrganizationCreated AuditAction = "organization.created"
	ActionUserRegistered      AuditAction = "user.registered"
	ActionUserSignedIn        AuditAction = "user.signed_in"
	ActionUserSignedOut       AuditAction = "user.signed_out"
	ActionPasswordChanged     AuditAction = "user.password_changed"
	ActionPasswordResetAsked  AuditAction = "user.password_reset_requested"
	ActionPasswordResetDone   AuditAction = "user.password_reset_completed"
	ActionSessionsRevoked     AuditAction = "user.sessions_revoked"
	ActionTOTPEnabled         AuditAction = "user.totp_enabled"
	ActionTOTPDisabled        AuditAction = "user.totp_disabled"
	ActionRecoveryCodeUsed    AuditAction = "user.recovery_code_used"
	ActionInvitationSent      AuditAction = "invitation.sent"
	ActionInvitationRevoked   AuditAction = "invitation.revoked"
	ActionInvitationAccepted  AuditAction = "invitation.accepted"
	ActionMemberRoleChanged   AuditAction = "membership.role_changed"
	ActionMemberRemoved       AuditAction = "membership.removed"
	ActionAccountDeleted      AuditAction = "user.deleted"
	ActionDataExported        AuditAction = "user.data_exported"
)

// AuditEvent is one entry in the trail.
//
// It is written in the same transaction as the change it describes, so there
// is no change without its record and no record of a change that rolled back.
// The application role may insert and read these rows and nothing else: the
// migration revokes UPDATE and DELETE, so a trail cannot be quietly corrected.
//
// Fields names what changed, never the values. A changed CPF must leave a
// trace without the trail becoming a second, unencrypted copy of the data.
type AuditEvent struct {
	ID uuid.UUID
	// OrganizationID is nil for events that happen before or outside any
	// organisation, such as a password reset.
	OrganizationID *uuid.UUID
	// ActorID is nil when nobody was signed in, as in a reset completed from
	// a mailed link.
	ActorID    *uuid.UUID
	Action     AuditAction
	EntityType string
	EntityID   *uuid.UUID
	Fields     []string
	RequestID  string
	IP         *netip.Addr
	OccurredAt time.Time
}

// AccessEvent names a kind of access record.
type AccessEvent string

const (
	AccessSignIn        AccessEvent = "sign_in"
	AccessSignInRefused AccessEvent = "sign_in_refused"
	AccessRefresh       AccessEvent = "refresh"
	AccessSignOut       AccessEvent = "sign_out"
	// AccessAccountClosed is the last record an account leaves: its owner
	// deleted it, from this address.
	AccessAccountClosed AccessEvent = "account_closed"
)

// AccessRecord is a record of use of the application from an address, kept for
// six months.
//
// The Marco Civil da Internet (art. 15) requires an application provider
// established as a legal entity to keep these records, under confidentiality,
// for six months. Art. 5, VIII defines them as the date and time of use of an
// application from a given IP address, which is why the address and the port
// are part of the record and the instant carries its zone.
//
// They are not the audit trail and not the operational log: they answer one
// question, put by a court order, and nothing else.
type AccessRecord struct {
	ID         uuid.UUID
	UserID     *uuid.UUID
	Event      AccessEvent
	IP         *netip.Addr
	Port       int
	OccurredAt time.Time
}

// AccessRecordRetention is how long those records are kept. Six months is the
// legal minimum and, since they are personal data, also the maximum worth
// keeping: art. 15 obliges the provider to keep them, and the LGPD's
// minimisation asks for nothing beyond that.
const AccessRecordRetention = 6 * 30 * 24 * time.Hour
