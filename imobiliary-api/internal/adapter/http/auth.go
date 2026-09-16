package http

import (
	"net/http"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- accounts ---------------------------------------------------------------

type registerRequest struct {
	Email            string `json:"email"`
	Name             string `json:"name"`
	Password         string `json:"password"`
	OrganizationName string `json:"organization_name"`
	TermsVersion     string `json:"terms_version"`
}

// handleRegister opens an account and the office it administers.
//
// It answers 202 with no body whatever happened, as long as the input was
// well formed: created, or the address already had an account. Answering
// differently would let anyone ask which addresses are registered, and the
// owner of a taken address is told by mail instead.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body registerRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}

	_, err := s.identity.Register(r.Context(), usecase.Registration{
		Email:            body.Email,
		Name:             body.Name,
		Password:         body.Password,
		OrganizationName: body.OrganizationName,
		TermsVersion:     body.TermsVersion,
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// --- sessions ---------------------------------------------------------------

type signInRequest struct {
	Email          string `json:"email"`
	Password       string `json:"password"`
	OrganizationID string `json:"organization_id,omitzero"`
}

func (s *Server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	var body signInRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	organizationID, err := optionalUUID(body.OrganizationID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	result, err := s.identity.SignIn(r.Context(), body.Email, body.Password, organizationID)
	if err != nil {
		s.auditor.Access(r.Context(), nil, domain.AccessSignInRefused)
		writeError(w, s.logger, err)
		return
	}

	out := signInBody{
		MFARequired:   result.NeedsSecondFactor(),
		Organizations: presentMemberships(result.Organizations),
	}
	if result.NeedsSecondFactor() {
		expiresAt := result.ChallengeExpiresAt
		out.Challenge, out.ChallengeExpiresAt = result.Challenge, &expiresAt
	} else {
		session := presentSession(result.Session)
		out.Session = &session
		s.auditor.Access(r.Context(), &result.Session.User.ID, domain.AccessSignIn)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

type completeMFARequest struct {
	Challenge      string `json:"challenge"`
	Code           string `json:"code"`
	OrganizationID string `json:"organization_id,omitzero"`
}

// handleCompleteMFA finishes a sign-in that stopped for the second factor. The
// code is either the six digits from the app or a recovery code.
func (s *Server) handleCompleteMFA(w http.ResponseWriter, r *http.Request) {
	var body completeMFARequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	organizationID, err := optionalUUID(body.OrganizationID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	session, err := s.mfa.CompleteSignIn(r.Context(), body.Challenge, body.Code, organizationID)
	if err != nil {
		s.auditor.Access(r.Context(), nil, domain.AccessSignInRefused)
		writeError(w, s.logger, err)
		return
	}
	s.auditor.Access(r.Context(), &session.User.ID, domain.AccessSignIn)
	writeJSON(w, s.logger, http.StatusOK, presentSession(session))
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var body refreshRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}

	session, err := s.identity.Refresh(r.Context(), body.RefreshToken)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	s.auditor.Access(r.Context(), &session.User.ID, domain.AccessRefresh)
	writeJSON(w, s.logger, http.StatusOK, presentSession(session))
}

type switchRequest struct {
	RefreshToken   string `json:"refresh_token"`
	OrganizationID string `json:"organization_id"`
}

// handleSwitchOrganization moves a session to another office the same account
// belongs to. It rotates the refresh token, so the browser holds one session.
func (s *Server) handleSwitchOrganization(w http.ResponseWriter, r *http.Request) {
	var body switchRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	organizationID, err := requiredUUID("organization_id", body.OrganizationID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	session, err := s.identity.SwitchOrganization(r.Context(), body.RefreshToken, organizationID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, presentSession(session))
}

func (s *Server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	var body refreshRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.identity.SignOut(r.Context(), body.RefreshToken); err != nil {
		writeError(w, s.logger, err)
		return
	}
	s.auditor.Access(r.Context(), nil, domain.AccessSignOut)
	w.WriteHeader(http.StatusNoContent)
}

// --- the account itself -----------------------------------------------------

type meBody struct {
	User          userBody         `json:"user"`
	Organization  organizationBody `json:"organization"`
	Role          domain.Role      `json:"role"`
	Organizations []membershipBody `json:"organizations"`
	// MFAEnrollmentRequired repeats the session's flag, so a client that
	// reloaded and kept only the access token still knows.
	MFAEnrollmentRequired bool `json:"mfa_enrollment_required"`
	RecoveryCodesLeft     int  `json:"recovery_codes_left"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	caller := callerFrom(r.Context())

	memberships, err := s.identity.Organizations(r.Context(), caller.User.ID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	remaining := 0
	if caller.User.HasTOTP() {
		if remaining, err = s.mfa.RemainingRecoveryCodes(r.Context(), caller); err != nil {
			writeError(w, s.logger, err)
			return
		}
	}

	writeJSON(w, s.logger, http.StatusOK, meBody{
		User:                  presentUser(caller.User),
		Organization:          presentOrganization(caller.Organization),
		Role:                  caller.Role,
		Organizations:         presentMemberships(memberships),
		MFAEnrollmentRequired: caller.MFAEnrollmentRequired,
		RecoveryCodesLeft:     remaining,
	})
}

// --- passwords --------------------------------------------------------------

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body changePasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.passwords.Change(r.Context(), callerFrom(r.Context()), body.CurrentPassword, body.NewPassword); err != nil {
		writeError(w, s.logger, err)
		return
	}
	// Every session ended, this one included: the client signs in again.
	w.WriteHeader(http.StatusNoContent)
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

// handleForgotPassword always answers 202, whatever the address was. Anything
// else would turn recovery into a directory of who has an account.
func (s *Server) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body forgotPasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	s.passwords.Forget(r.Context(), body.Email)
	w.WriteHeader(http.StatusAccepted)
}

type resetPasswordRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var body resetPasswordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.passwords.Reset(r.Context(), body.Token, body.Password); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- the second factor ------------------------------------------------------

type enrollmentBody struct {
	Secret string `json:"secret"`
	URI    string `json:"uri"`
}

func (s *Server) handleStartEnrollment(w http.ResponseWriter, r *http.Request) {
	enrollment, err := s.mfa.StartEnrollment(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, enrollmentBody{Secret: enrollment.Secret, URI: enrollment.URI})
}

type codeRequest struct {
	Code string `json:"code"`
}

type recoveryCodesBody struct {
	RecoveryCodes []string `json:"recovery_codes"`
}

// handleConfirmEnrollment turns the second factor on and hands back the
// recovery codes, which exist in the clear only in this response.
func (s *Server) handleConfirmEnrollment(w http.ResponseWriter, r *http.Request) {
	var body codeRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	codes, err := s.mfa.Confirm(r.Context(), callerFrom(r.Context()), body.Code)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, recoveryCodesBody{RecoveryCodes: codes})
}

type passwordRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleDisableMFA(w http.ResponseWriter, r *http.Request) {
	var body passwordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	if err := s.mfa.Disable(r.Context(), callerFrom(r.Context()), body.Password); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRegenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	var body passwordRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	codes, err := s.mfa.RegenerateRecoveryCodes(r.Context(), callerFrom(r.Context()), body.Password)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, recoveryCodesBody{RecoveryCodes: codes})
}

// --- helpers ----------------------------------------------------------------

// optionalUUID reads an identifier a client may leave out.
func optionalUUID(raw string) (uuid.UUID, error) {
	if raw == "" {
		return uuid.Nil(), nil
	}
	return requiredUUID("organization_id", raw)
}

// requiredUUID reads an identifier, reporting a field error rather than a
// parse failure, so the client sees which field it was.
func requiredUUID(field, raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		v := &domain.ValidationError{}
		v.Add(field, "is not a valid identifier")
		return uuid.Nil(), v
	}
	return id, nil
}

// now is the server's clock, used where a response has to say what a state is
// at this moment, such as whether an invitation has expired.
func (s *Server) now() time.Time { return s.clock().UTC() }
