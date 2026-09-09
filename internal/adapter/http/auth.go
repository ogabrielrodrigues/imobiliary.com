package http

import (
	"net/http"
	"time"

	"docgen/internal/domain"
	"docgen/internal/usecase"
)

// registerRequest is the body of POST /v1/auth/register.
type registerRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
}

// loginRequest is the body of POST /v1/auth/login.
type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// refreshRequest is the body of the refresh and logout endpoints.
type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// userResponse is how an account is presented. The password hash is absent by
// construction rather than by being stripped later.
type userResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// sessionResponse carries a freshly minted credential pair.
type sessionResponse struct {
	AccessToken      string       `json:"access_token"`
	TokenType        string       `json:"token_type"`
	ExpiresAt        time.Time    `json:"expires_at"`
	RefreshToken     string       `json:"refresh_token"`
	RefreshExpiresAt time.Time    `json:"refresh_expires_at"`
	User             userResponse `json:"user"`
}

func newUserResponse(u *domain.User) userResponse {
	return userResponse{
		ID:        u.ID.String(),
		Email:     u.Email,
		Name:      u.Name,
		CreatedAt: u.CreatedAt,
	}
}

func newSessionResponse(s *usecase.Session) sessionResponse {
	return sessionResponse{
		AccessToken:      s.AccessToken,
		TokenType:        "Bearer",
		ExpiresAt:        s.AccessExpiresAt,
		RefreshToken:     s.RefreshToken,
		RefreshExpiresAt: s.RefreshExpiresAt,
		User:             newUserResponse(s.User),
	}
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body registerRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	user, err := s.identity.Register(r.Context(), body.Email, body.Name, body.Password)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, newUserResponse(user))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body loginRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	session, err := s.identity.Login(r.Context(), body.Email, body.Password)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newSessionResponse(session))
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var body refreshRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	session, err := s.identity.Refresh(r.Context(), body.RefreshToken)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newSessionResponse(session))
}

// handleLogout always answers 204, whether or not the secret matched a live
// session. The caller's intent is satisfied either way, and a distinct response
// for an unknown secret would help an attacker probe for valid ones.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	var body refreshRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	if err := s.identity.Logout(r.Context(), body.RefreshToken); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.logger, http.StatusOK, newUserResponse(userFrom(r.Context())))
}
