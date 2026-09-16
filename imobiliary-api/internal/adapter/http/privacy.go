package http

import (
	"net/http"
	"net/netip"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- the export -------------------------------------------------------------

// exportBody is the copy of an account's data. It is shaped for a person
// reading it as much as for a program: each section says what it is, and no
// section carries a secret (see usecase.AccountExport).
type exportBody struct {
	ExportedAt          time.Time              `json:"exported_at"`
	Account             exportAccountBody      `json:"account"`
	Memberships         []exportMembershipBody `json:"memberships"`
	SecondFactor        exportTOTPBody         `json:"second_factor"`
	Sessions            []exportSessionBody    `json:"sessions"`
	InvitationsReceived []exportInvitationBody `json:"invitations_received"`
	AuditEvents         []exportAuditBody      `json:"audit_events"`
	AccessRecords       []exportAccessBody     `json:"access_records"`
}

type exportAccountBody struct {
	ID                string     `json:"id"`
	Email             string     `json:"email"`
	Name              string     `json:"name"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	PasswordChangedAt *time.Time `json:"password_changed_at"`
	TermsVersion      string     `json:"terms_version"`
	TermsAcceptedAt   *time.Time `json:"terms_accepted_at"`
}

type exportMembershipBody struct {
	Organization organizationBody `json:"organization"`
	Role         domain.Role      `json:"role"`
	JoinedAt     time.Time        `json:"joined_at"`
}

type exportTOTPBody struct {
	Enabled           bool       `json:"enabled"`
	ConfirmedAt       *time.Time `json:"confirmed_at"`
	RecoveryCodesLeft int        `json:"recovery_codes_left"`
}

type exportSessionBody struct {
	ID             string     `json:"id"`
	OrganizationID string     `json:"organization_id"`
	CreatedAt      time.Time  `json:"created_at"`
	ExpiresAt      time.Time  `json:"expires_at"`
	UsedAt         *time.Time `json:"used_at"`
	RevokedAt      *time.Time `json:"revoked_at"`
}

type exportInvitationBody struct {
	ID               string                  `json:"id"`
	OrganizationID   string                  `json:"organization_id"`
	OrganizationName string                  `json:"organization_name"`
	Role             domain.Role             `json:"role"`
	Status           domain.InvitationStatus `json:"status"`
	CreatedAt        time.Time               `json:"created_at"`
	ExpiresAt        time.Time               `json:"expires_at"`
	AcceptedAt       *time.Time              `json:"accepted_at"`
	RevokedAt        *time.Time              `json:"revoked_at"`
}

type exportAuditBody struct {
	ID             string             `json:"id"`
	OrganizationID *string            `json:"organization_id"`
	Action         domain.AuditAction `json:"action"`
	EntityType     string             `json:"entity_type"`
	EntityID       *string            `json:"entity_id"`
	Fields         []string           `json:"fields"`
	RequestID      string             `json:"request_id"`
	IP             *netip.Addr        `json:"ip"`
	OccurredAt     time.Time          `json:"occurred_at"`
}

type exportAccessBody struct {
	ID         string             `json:"id"`
	Event      domain.AccessEvent `json:"event"`
	IP         *netip.Addr        `json:"ip"`
	Port       int                `json:"port"`
	OccurredAt time.Time          `json:"occurred_at"`
}

func presentExport(e *usecase.AccountExport, now time.Time) exportBody {
	u := e.User
	out := exportBody{
		ExportedAt: e.ExportedAt,
		Account: exportAccountBody{
			ID: u.ID.String(), Email: u.Email, Name: u.Name,
			CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt,
			PasswordChangedAt: u.PasswordChangedAt,
			TermsVersion:      u.TermsVersion, TermsAcceptedAt: u.TermsAcceptedAt,
		},
		SecondFactor: exportTOTPBody{
			Enabled: u.HasTOTP(), ConfirmedAt: u.TOTPConfirmedAt, RecoveryCodesLeft: e.RecoveryCodesLeft,
		},
		Memberships:         make([]exportMembershipBody, 0, len(e.Memberships)),
		Sessions:            make([]exportSessionBody, 0, len(e.Sessions)),
		InvitationsReceived: make([]exportInvitationBody, 0, len(e.Invitations)),
		AuditEvents:         make([]exportAuditBody, 0, len(e.AuditEvents)),
		AccessRecords:       make([]exportAccessBody, 0, len(e.AccessRecords)),
	}
	for _, m := range e.Memberships {
		out.Memberships = append(out.Memberships, exportMembershipBody{
			Organization: presentOrganization(m.Organization), Role: m.Role, JoinedAt: m.JoinedAt,
		})
	}
	for _, s := range e.Sessions {
		out.Sessions = append(out.Sessions, exportSessionBody{
			ID: s.ID.String(), OrganizationID: s.OrganizationID.String(),
			CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt, UsedAt: s.UsedAt, RevokedAt: s.RevokedAt,
		})
	}
	for _, r := range e.Invitations {
		i := r.Invitation
		out.InvitationsReceived = append(out.InvitationsReceived, exportInvitationBody{
			ID: i.ID.String(), OrganizationID: i.OrganizationID.String(), OrganizationName: r.OrganizationName,
			Role: i.Role, Status: i.StatusAt(now), CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt,
			AcceptedAt: i.AcceptedAt, RevokedAt: i.RevokedAt,
		})
	}
	for _, a := range e.AuditEvents {
		out.AuditEvents = append(out.AuditEvents, exportAuditBody{
			ID: a.ID.String(), OrganizationID: optionalID(a.OrganizationID), Action: a.Action,
			EntityType: a.EntityType, EntityID: optionalID(a.EntityID), Fields: nonNil(a.Fields),
			RequestID: a.RequestID, IP: a.IP, OccurredAt: a.OccurredAt,
		})
	}
	for _, r := range e.AccessRecords {
		out.AccessRecords = append(out.AccessRecords, exportAccessBody{
			ID: r.ID.String(), Event: r.Event, IP: r.IP, Port: r.Port, OccurredAt: r.OccurredAt,
		})
	}
	return out
}

// handleExport answers the access right (LGPD art. 18, II). A GET, because it
// changes nothing but the trail, and charged to the write budget, because it
// is the most expensive read the account can ask for.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	export, err := s.privacy.Export(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, presentExport(export, s.now()))
}

// --- erasure ----------------------------------------------------------------

// handleDeleteAccount answers the erasure right (LGPD art. 18, VI).
//
// A POST to a resource of its own rather than a DELETE on /v1/me, because it
// carries the password in a body, and a body on DELETE is one that proxies and
// clients are allowed to drop.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	var body passwordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.privacy.DeleteAccount(r.Context(), callerFrom(r.Context()), body.Password); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func optionalID(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	text := id.String()
	return &text
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
