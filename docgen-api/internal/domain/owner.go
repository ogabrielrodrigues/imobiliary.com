package domain

import (
	"strings"
	"time"
	"uuid"
)

// OwnerKind says what owns templates, documents and batches.
type OwnerKind string

const (
	// OwnerOrganization is an office of the Imobiliary platform, which owns
	// identity. Every member of the office works with the same templates.
	OwnerOrganization OwnerKind = "organization"
	// OwnerLegacyAccount is an account of this service from before identity
	// moved to the platform. It keeps its rows until someone of an office signs
	// in with its e-mail, and then they move to that office, once.
	OwnerLegacyAccount OwnerKind = "legacy_account"
)

// Owner is what owns templates, documents and batches.
type Owner struct {
	ID         uuid.UUID
	Kind       OwnerKind
	Name       string
	Email      string // legacy accounts only
	MergedInto *uuid.UUID
	MergedAt   *time.Time
	CreatedAt  time.Time
}

// NormalizeEmail lowercases and trims an address so that lookups agree on
// what counts as the same account.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
