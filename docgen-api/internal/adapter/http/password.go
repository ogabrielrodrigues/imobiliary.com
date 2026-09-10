package http

import (
	"log/slog"
	"net/http"
)

// changePasswordRequest is the body of POST /v1/me/password.
type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// forgotPasswordRequest is the body of POST /v1/auth/password/forgot.
type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// resetPasswordRequest is the body of POST /v1/auth/password/reset.
type resetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

// handleChangePassword replaces the caller's password and hands back a new
// session.
//
// A session comes back because the change ends every session of the account,
// this one included. Returning a fresh pair is what lets the browser that asked
// keep working while all the others stop, without the caller having to sign in
// again a second after proving it knows the password.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body changePasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	session, err := s.passwords.Change(r.Context(), userFrom(r.Context()).ID,
		body.CurrentPassword, body.NewPassword)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newSessionResponse(session))
}

// handleForgotPassword mails a reset link, and says nothing about whether it
// found an account.
//
// Always 202, always the same. Answering differently for a known and an unknown
// address would turn an endpoint reachable without credentials into a way to
// ask which addresses are registered here.
func (s *Server) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body forgotPasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	if err := s.passwords.RequestReset(r.Context(), body.Email); err != nil {
		// Logged, not reported. A failure here is ours — a mail provider being
		// unreachable, say — and telling the caller about it would leak that
		// the address matched an account.
		s.logger.Error("could not start a password reset", slog.Any("error", err))
	}
	w.WriteHeader(http.StatusAccepted)
}

// handleResetPassword sets a new password from a one-time token.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body resetPasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	if err := s.passwords.Reset(r.Context(), body.Token, body.NewPassword); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
