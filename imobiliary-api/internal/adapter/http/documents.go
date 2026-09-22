package http

import (
	"net/http"
	"time"

	"imobiliary/internal/platform/token"
)

type documentFieldBody struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type documentFieldsBody struct {
	Fields []documentFieldBody `json:"fields"`
}

// handleContractDocumentFields answers every field a lease template can use,
// computed for one contract.
func (s *Server) handleContractDocumentFields(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	fields, err := s.documents.ContractFields(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := documentFieldsBody{Fields: make([]documentFieldBody, 0, len(fields))}
	for _, f := range fields {
		out.Fields = append(out.Fields, documentFieldBody{Name: f.Name, Value: f.Value})
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handlePayoutDocumentFields(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("payout_id", r.PathValue("payoutID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	fields, err := s.documents.PayoutFields(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := documentFieldsBody{Fields: make([]documentFieldBody, 0, len(fields))}
	for _, f := range fields {
		out.Fields = append(out.Fields, documentFieldBody{Name: f.Name, Value: f.Value})
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

type docgenTokenBody struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// handleDocgenToken mints a token for the document service for the caller's
// session: the user, the office they are working in, and their role there.
func (s *Server) handleDocgenToken(w http.ResponseWriter, r *http.Request) {
	caller := callerFrom(r.Context())
	raw, expiresAt, err := s.signer.IssueDocgen(token.DocgenSubject{
		UserID:           caller.User.ID,
		OrganizationID:   caller.Organization.ID,
		OrganizationName: caller.Organization.Name,
		Email:            caller.User.Email,
		Name:             caller.User.Name,
		Role:             string(caller.Role),
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, docgenTokenBody{Token: raw, ExpiresAt: expiresAt})
}
