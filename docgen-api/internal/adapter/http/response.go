// Package http exposes the service over HTTP using only net/http: routing is
// http.ServeMux, which since Go 1.22 understands method and wildcard patterns,
// so no third-party router is involved.
package http

import (
	json "encoding/json/v2"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"

	"docgen/internal/domain"
	"docgen/internal/platform/token"
)

// errorCode is the stable, machine-readable label a client can branch on. The
// human-readable message may be reworded; these values may not.
type errorCode string

const (
	codeValidation     errorCode = "validation_failed"
	codeNotFound       errorCode = "not_found"
	codeConflict       errorCode = "conflict"
	codeUnauthorized   errorCode = "unauthorized"
	codeRateLimited    errorCode = "rate_limited"
	codePayloadTooBig  errorCode = "payload_too_large"
	codeBadRequest     errorCode = "bad_request"
	codeInternal       errorCode = "internal_error"
	codeUnsupportedTyp errorCode = "unsupported_media_type"
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
		// The status line is already on the wire, so the response cannot be
		// changed; all that is left is to record the failure.
		logger.Error("encoding response body failed", slog.Any("error", err))
	}
}

// writeError maps an error to a status code and a response body.
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

	case errors.Is(err, domain.ErrAlreadyExists):
		writeFailure(w, logger, http.StatusConflict, codeConflict, "resource already exists")

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

// writeFailure sends an error body with no field details.
func writeFailure(w http.ResponseWriter, logger *slog.Logger, status int, code errorCode, message string) {
	writeJSON(w, logger, status, errorBody{errorPayload{Code: code, Message: message}})
}

// decodeJSON reads a JSON request body into dst.
//
// json/v2 rejects duplicate object names and invalid UTF-8 by default, and
// UnmarshalRead additionally requires the stream to end after the value, so
// trailing rubbish is an error rather than something silently ignored.
func decodeJSON(r *http.Request, dst any) error {
	if err := json.UnmarshalRead(r.Body, dst); err != nil {
		v := &domain.ValidationError{}
		// The decoder message is not repeated: it can quote a fragment of the
		// submitted body and names internals the caller has no use for.
		v.Add("body", "is not valid JSON")
		return v
	}
	return nil
}

// requireContentType checks the media type of a request body, ignoring any
// parameters such as a charset or a multipart boundary. An absent header is
// accepted, since a body-less request has nothing to describe.
func requireContentType(r *http.Request, want string) error {
	header := r.Header.Get("Content-Type")
	if header == "" {
		return nil
	}

	got, _, err := mime.ParseMediaType(header)
	if err != nil || got != want {
		return fmt.Errorf("expected content type %s, got %q", want, header)
	}
	return nil
}
