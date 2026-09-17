package http

import (
	"net/http"
	"time"

	"docgen/internal/domain"
)

// ownerResponse is the office that owns what a request touches.
type ownerResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func newOwnerResponse(o *domain.Owner) ownerResponse {
	return ownerResponse{ID: o.ID.String(), Name: o.Name, CreatedAt: o.CreatedAt}
}

// meResponse is who the token speaks for, and in which office.
type meResponse struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Office ownerResponse `json:"office"`
	Role   string        `json:"role"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	caller := callerFrom(r.Context())
	owner, err := s.access.Owner(r.Context(), caller)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	var out meResponse
	out.User.ID, out.User.Email, out.User.Name = caller.UserID.String(), caller.Email, caller.Name
	out.Office, out.Role = newOwnerResponse(owner), caller.Role
	writeJSON(w, s.logger, http.StatusOK, out)
}

// handleGone answers the routes that left with identity (PLANO-FASE-7.md §4):
// accounts, sessions and passwords now live on the Imobiliary platform.
func (s *Server) handleGone(w http.ResponseWriter, r *http.Request) {
	writeFailure(w, s.logger, http.StatusGone, codeGone,
		"accounts and sessions moved to the Imobiliary platform")
}
