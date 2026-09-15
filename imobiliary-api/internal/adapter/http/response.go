// Package http exposes the service over HTTP using only net/http: routing is
// http.ServeMux, which understands method and wildcard patterns, so no
// third-party router is involved.
package http

import (
	json "encoding/json/v2"
	"log/slog"
	"net/http"

	"imobiliary/internal/domain"
)

// errorCode is the stable, machine-readable label a client can branch on. The
// human-readable message may be reworded; these values may not.
type errorCode string

const (
	codeNotFound    errorCode = "not_found"
	codeInternal    errorCode = "internal_error"
	codeUnavailable errorCode = "unavailable"
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
