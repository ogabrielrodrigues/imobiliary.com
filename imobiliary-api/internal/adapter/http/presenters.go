package http

import (
	"time"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// The shapes this API answers with.
//
// They are written out here rather than reusing the domain entities, because
// the two change for different reasons: a field added to an entity must not
// appear in a response by accident, and a password hash must never appear at
// all. Every instant is RFC 3339 with an offset; every calendar date is
// YYYY-MM-DD, which is what domain.Date marshals to.

type userBody struct {
	ID              string     `json:"id"`
	Email           string     `json:"email"`
	Name            string     `json:"name"`
	CreatedAt       time.Time  `json:"created_at"`
	TOTPEnabled     bool       `json:"totp_enabled"`
	TermsVersion    string     `json:"terms_version,omitzero"`
	TermsAcceptedAt *time.Time `json:"terms_accepted_at,omitzero"`
}

func presentUser(u *domain.User) userBody {
	return userBody{
		ID:              u.ID.String(),
		Email:           u.Email,
		Name:            u.Name,
		CreatedAt:       u.CreatedAt,
		TOTPEnabled:     u.HasTOTP(),
		TermsVersion:    u.TermsVersion,
		TermsAcceptedAt: u.TermsAcceptedAt,
	}
}

type organizationBody struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func presentOrganization(o *domain.Organization) organizationBody {
	return organizationBody{ID: o.ID.String(), Name: o.Name, CreatedAt: o.CreatedAt}
}

type membershipBody struct {
	Organization organizationBody `json:"organization"`
	Role         domain.Role      `json:"role"`
}

func presentMemberships(memberships []usecase.MembershipWithOrganization) []membershipBody {
	out := make([]membershipBody, 0, len(memberships))
	for _, m := range memberships {
		out = append(out, membershipBody{Organization: presentOrganization(m.Organization), Role: m.Role})
	}
	return out
}

type sessionBody struct {
	User             userBody         `json:"user"`
	Organization     organizationBody `json:"organization"`
	Role             domain.Role      `json:"role"`
	AccessToken      string           `json:"access_token"`
	AccessExpiresAt  time.Time        `json:"access_expires_at"`
	RefreshToken     string           `json:"refresh_token"`
	RefreshExpiresAt time.Time        `json:"refresh_expires_at"`
	// MFAEnrollmentRequired tells the client that this session may do nothing
	// but enrol a second factor, which is the rule for an administrator.
	MFAEnrollmentRequired bool `json:"mfa_enrollment_required"`
}

func presentSession(s *usecase.Session) sessionBody {
	return sessionBody{
		User:                  presentUser(s.User),
		Organization:          presentOrganization(s.Organization),
		Role:                  s.Role,
		AccessToken:           s.AccessToken,
		AccessExpiresAt:       s.AccessExpiresAt,
		RefreshToken:          s.RefreshToken,
		RefreshExpiresAt:      s.RefreshExpiresAt,
		MFAEnrollmentRequired: s.MFAEnrollmentRequired,
	}
}

// signInBody is either a session or a challenge, never both: a client checks
// mfa_required and reads the half that is there.
type signInBody struct {
	MFARequired        bool             `json:"mfa_required"`
	Session            *sessionBody     `json:"session,omitzero"`
	Challenge          string           `json:"challenge,omitzero"`
	ChallengeExpiresAt *time.Time       `json:"challenge_expires_at,omitzero"`
	Organizations      []membershipBody `json:"organizations"`
}

type memberBody struct {
	User     userBody    `json:"user"`
	Role     domain.Role `json:"role"`
	JoinedAt time.Time   `json:"joined_at"`
}

func presentMembers(members []usecase.Member) []memberBody {
	out := make([]memberBody, 0, len(members))
	for _, m := range members {
		out = append(out, memberBody{User: presentUser(m.User), Role: m.Role, JoinedAt: m.JoinedAt})
	}
	return out
}

type invitationBody struct {
	ID        string                  `json:"id"`
	Email     string                  `json:"email"`
	Role      domain.Role             `json:"role"`
	Status    domain.InvitationStatus `json:"status"`
	CreatedAt time.Time               `json:"created_at"`
	ExpiresAt time.Time               `json:"expires_at"`
}

func presentInvitation(i *domain.Invitation, now time.Time) invitationBody {
	return invitationBody{
		ID:        i.ID.String(),
		Email:     i.Email,
		Role:      i.Role,
		Status:    i.StatusAt(now),
		CreatedAt: i.CreatedAt,
		ExpiresAt: i.ExpiresAt,
	}
}

func presentInvitations(invitations []*domain.Invitation, now time.Time) []invitationBody {
	out := make([]invitationBody, 0, len(invitations))
	for _, i := range invitations {
		out = append(out, presentInvitation(i, now))
	}
	return out
}

// pendingInvitationBody is what the acceptance screen reads before anyone
// types anything. It names the office and the address, and says whether the
// person already has an account, so the screen knows what to ask for.
type pendingInvitationBody struct {
	Organization  organizationBody `json:"organization"`
	Email         string           `json:"email"`
	Role          domain.Role      `json:"role"`
	AccountExists bool             `json:"account_exists"`
}
