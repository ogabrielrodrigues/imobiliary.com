package http

import (
	"net/http"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- the office -------------------------------------------------------------

func (s *Server) handleOrganization(w http.ResponseWriter, r *http.Request) {
	caller := callerFrom(r.Context())
	writeJSON(w, s.logger, http.StatusOK, presentOrganization(caller.Organization))
}

type renameRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleRenameOrganization(w http.ResponseWriter, r *http.Request) {
	var body renameRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.organizations.Rename(r.Context(), callerFrom(r.Context()), body.Name); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- members ----------------------------------------------------------------

type membersBody struct {
	Members []memberBody `json:"members"`
}

// handleMembers lists who works here. Every member may read it: they work
// together, and the list is not a secret from them.
func (s *Server) handleMembers(w http.ResponseWriter, r *http.Request) {
	members, err := s.organizations.Members(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, membersBody{Members: presentMembers(members)})
}

type roleRequest struct {
	Role domain.Role `json:"role"`
}

func (s *Server) handleChangeRole(w http.ResponseWriter, r *http.Request) {
	userID, err := requiredUUID("user_id", r.PathValue("userID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	var body roleRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.organizations.ChangeRole(r.Context(), callerFrom(r.Context()), userID, body.Role); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	userID, err := requiredUUID("user_id", r.PathValue("userID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.organizations.RemoveMember(r.Context(), callerFrom(r.Context()), userID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- invitations ------------------------------------------------------------

type invitationsBody struct {
	Invitations []invitationBody `json:"invitations"`
}

func (s *Server) handleInvitations(w http.ResponseWriter, r *http.Request) {
	invitations, err := s.organizations.Invitations(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, invitationsBody{Invitations: presentInvitations(invitations, s.now())})
}

type inviteRequest struct {
	Email string      `json:"email"`
	Role  domain.Role `json:"role"`
}

// handleInvite creates an invitation. The secret goes out by mail and never
// appears in this response: an administrator who could read it could set the
// invited person's password.
func (s *Server) handleInvite(w http.ResponseWriter, r *http.Request) {
	var body inviteRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	invitation, err := s.organizations.Invite(r.Context(), callerFrom(r.Context()), body.Email, body.Role)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, presentInvitation(invitation, s.now()))
}

func (s *Server) handleRevokeInvitation(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("invitation_id", r.PathValue("invitationID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.organizations.RevokeInvitation(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- joining ----------------------------------------------------------------

type invitationLookupRequest struct {
	Token string `json:"token"`
}

// handleLookupInvitation reads an invitation by its secret, for the screen
// that shows who is inviting whom.
//
// A POST with the secret in the body, not a GET with it in the path: a path is
// written to access logs, browser history and any proxy in between, and this
// secret is enough to join an office.
func (s *Server) handleLookupInvitation(w http.ResponseWriter, r *http.Request) {
	var body invitationLookupRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	pending, err := s.organizations.Invitation(r.Context(), body.Token)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, pendingInvitationBody{
		Organization:  presentOrganization(pending.Organization),
		Email:         pending.Email,
		Role:          pending.Role,
		AccountExists: pending.AccountExists,
	})
}

type acceptInvitationRequest struct {
	Token        string `json:"token"`
	Name         string `json:"name,omitzero"`
	Password     string `json:"password,omitzero"`
	TermsVersion string `json:"terms_version,omitzero"`
}

// handleAcceptInvitation joins the office, creating the account when there is
// none. It answers 204: the client signs in afterwards, so no session is
// minted from a link that arrived by mail.
func (s *Server) handleAcceptInvitation(w http.ResponseWriter, r *http.Request) {
	var body acceptInvitationRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	_, err := s.organizations.Accept(r.Context(), usecase.Acceptance{
		Secret:       body.Token,
		Name:         body.Name,
		Password:     body.Password,
		TermsVersion: body.TermsVersion,
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
