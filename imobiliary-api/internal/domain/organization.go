package domain

import (
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// MaxOrganizationNameLength bounds the name of an office.
const MaxOrganizationNameLength = 120

// Organization is the office whose data the platform holds: its properties,
// its people, its contracts. Every business record belongs to exactly one, and
// a user reaches it through a membership.
type Organization struct {
	ID        uuid.UUID
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Role is what a member may do inside an organisation.
//
// Two roles, not a permission matrix: an office of this size has people who
// run it and people who work in it, and anything finer would be more to build,
// more to test and more to explain than it is worth today.
type Role string

const (
	// RoleAdmin manages members, invitations and the organisation itself, on
	// top of everything a member does.
	RoleAdmin Role = "admin"
	// RoleMember works with people, properties, contracts and rents.
	RoleMember Role = "member"
)

// Roles are every role, in the order a picker should show them.
var Roles = []Role{RoleAdmin, RoleMember}

// IsValid reports whether r is a role this service knows.
func (r Role) IsValid() bool {
	return r == RoleAdmin || r == RoleMember
}

// Membership ties a user to an organisation with a role.
type Membership struct {
	OrganizationID uuid.UUID
	UserID         uuid.UUID
	Role           Role
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// IsAdmin reports whether the membership may manage the organisation.
func (m *Membership) IsAdmin() bool { return m.Role == RoleAdmin }

// ValidateOrganizationName checks the name of an office.
func ValidateOrganizationName(v *ValidationError, field, name string) {
	switch {
	case strings.TrimSpace(name) == "":
		v.Add(field, "is required")
	case utf8.RuneCountInString(name) > MaxOrganizationNameLength:
		v.Addf(field, "must be at most %d characters", MaxOrganizationNameLength)
	}
}

// ValidateRole checks a role arriving from a request.
func ValidateRole(v *ValidationError, field string, role Role) {
	if !role.IsValid() {
		v.Addf(field, "must be one of %s, %s", RoleAdmin, RoleMember)
	}
}
