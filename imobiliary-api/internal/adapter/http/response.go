// Package http exposes the service over HTTP using only net/http: routing is
// http.ServeMux, which understands method and wildcard patterns, so no
// third-party router is involved.
package http

import (
	json "encoding/json/v2"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"

	"imobiliary/internal/domain"
	"imobiliary/internal/platform/token"
)

// errorCode is the stable, machine-readable label a client can branch on. The
// human-readable message may be reworded; these values may not.
type errorCode string

const (
	codeValidation       errorCode = "validation_failed"
	codeNotFound         errorCode = "not_found"
	codeConflict         errorCode = "conflict"
	codeUnauthorized     errorCode = "unauthorized"
	codeForbidden        errorCode = "forbidden"
	codeMFARequired      errorCode = "mfa_required"
	codeMFAEnrollment    errorCode = "mfa_enrollment_required"
	codeRateLimited      errorCode = "rate_limited"
	codeBadRequest       errorCode = "bad_request"
	codeUnsupportedMedia errorCode = "unsupported_media_type"
	codePayloadTooLarge  errorCode = "payload_too_large"
	codeInternal         errorCode = "internal_error"
	codeUnavailable      errorCode = "unavailable"
	codePreconditionFail errorCode = "precondition_failed"
)

// errorBody is the single shape every failure takes, so a client needs one
// error path rather than one per endpoint.
type errorBody struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code    errorCode           `json:"code"`
	Message string              `json:"message"`
	Fields  []domain.FieldError `json:"fields,omitempty"`
}

// writeJSON sends a value as the response body.
func writeJSON(w http.ResponseWriter, logger *slog.Logger, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value == nil {
		return
	}
	if err := json.MarshalWrite(w, value); err != nil {
		// The status line is already on the wire; all that is left is to
		// record the failure.
		logger.Error("encoding response body failed", slog.Any("error", err))
	}
}

// writeFailure sends an error body with no field details.
func writeFailure(w http.ResponseWriter, logger *slog.Logger, status int, code errorCode, message string) {
	writeJSON(w, logger, status, errorBody{errorPayload{Code: code, Message: message}})
}

// writeError maps an error to a status code and a body.
//
// Mapping in one place is what keeps the handlers free of status codes and
// guarantees that an unexpected error can never leak its text to the client:
// anything unrecognised becomes a generic 500 and is logged instead.
func writeError(w http.ResponseWriter, logger *slog.Logger, err error) {
	var invalid *domain.ValidationError
	if errors.As(err, &invalid) {
		writeJSON(w, logger, http.StatusUnprocessableEntity, errorBody{errorPayload{
			Code:    codeValidation,
			Message: "the request could not be processed",
			Fields:  invalid.Fields,
		}})
		return
	}

	switch {
	case errors.Is(err, domain.ErrNotFound):
		writeFailure(w, logger, http.StatusNotFound, codeNotFound, "resource not found")

	case errors.Is(err, domain.ErrAlreadyExists), errors.Is(err, domain.ErrConflict):
		writeFailure(w, logger, http.StatusConflict, codeConflict, "the request conflicts with the current state")

	case errors.Is(err, domain.ErrPermissionDenied):
		// Deliberately not 404: the caller is authenticated and asking about
		// their own office, so "you may not" is the honest answer and hiding
		// it would only make the client guess.
		writeFailure(w, logger, http.StatusForbidden, codeForbidden, "not allowed")

	case errors.Is(err, domain.ErrMFARequired):
		writeFailure(w, logger, http.StatusUnauthorized, codeMFARequired, "second factor required")

	case errors.Is(err, domain.ErrInvalidCredentials),
		errors.Is(err, domain.ErrSessionExpired),
		errors.Is(err, domain.ErrSessionReused),
		errors.Is(err, token.ErrInvalidToken):
		// All four collapse into one response. Telling a caller that a session
		// was revoked for reuse, rather than simply rejected, would confirm to
		// a thief that the stolen secret had been genuine.
		writeFailure(w, logger, http.StatusUnauthorized, codeUnauthorized, "authentication failed")

	default:
		logger.Error("request failed", slog.Any("error", err))
		writeFailure(w, logger, http.StatusInternalServerError, codeInternal, "internal error")
	}
}

// decodeJSON reads a JSON request body into dst.
//
// json/v2 rejects duplicate object names and invalid UTF-8 by default, and
// UnmarshalRead additionally requires the stream to end after the value, so
// trailing rubbish is an error rather than something silently ignored.
func decodeJSON(r *http.Request, dst any) error {
	if err := requireContentType(r, "application/json"); err != nil {
		return err
	}
	if err := json.UnmarshalRead(r.Body, dst); err != nil {
		return fmt.Errorf("%w: %w", errBadRequest, err)
	}
	return nil
}

// errBadRequest marks a body this service could not read at all, as opposed to
// one it read and then refused.
var errBadRequest = errors.New("malformed request body")

func requireContentType(r *http.Request, want string) error {
	header := r.Header.Get("Content-Type")
	if header == "" {
		return fmt.Errorf("%w: a %s body is required", errUnsupportedMedia, want)
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil || mediaType != want {
		return fmt.Errorf("%w: a %s body is required", errUnsupportedMedia, want)
	}
	return nil
}

var errUnsupportedMedia = errors.New("unsupported media type")

// writeDecodeError answers a body that could not be read. The decoder's own
// message is not echoed: it repeats whatever the caller sent, which has no
// business being reflected back.
func writeDecodeError(w http.ResponseWriter, logger *slog.Logger, err error) {
	switch {
	case errors.Is(err, errUnsupportedMedia):
		writeFailure(w, logger, http.StatusUnsupportedMediaType, codeUnsupportedMedia, "send application/json")
	case errors.Is(err, http.ErrHandlerTimeout):
		writeFailure(w, logger, http.StatusRequestTimeout, codeBadRequest, "the request took too long")
	default:
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeFailure(w, logger, http.StatusRequestEntityTooLarge, codePayloadTooLarge, "the request body is too large")
			return
		}
		writeFailure(w, logger, http.StatusBadRequest, codeBadRequest, "the request body could not be read")
	}
}
