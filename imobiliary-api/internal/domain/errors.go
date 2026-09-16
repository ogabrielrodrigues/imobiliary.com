// Package domain holds the core entities and business rules of the service.
// It deliberately imports nothing from the rest of the module: every other
// layer depends on this one, never the reverse.
package domain

import (
	"errors"
	"fmt"
	"strings"
)

// Sentinel errors returned by the domain and by repository implementations.
// Callers compare them with errors.Is; the transport layer maps each one to an
// HTTP status code.
var (
	ErrNotFound      = errors.New("resource not found")
	ErrAlreadyExists = errors.New("resource already exists")
	ErrValidation    = errors.New("validation failed")

	// ErrInvalidCredentials covers a wrong password, an unknown address, a
	// spent link and a bad second factor alike. The transport tells them
	// apart nowhere: which one it was is exactly what an attacker is asking.
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrSessionExpired     = errors.New("session expired")
	// ErrSessionReused means a refresh token was presented twice. Two parties
	// hold it and there is no way to tell the owner from the thief, so every
	// session of the account ends.
	ErrSessionReused = errors.New("refresh token reused")
	// ErrPermissionDenied is a member attempting what only an admin may do.
	ErrPermissionDenied = errors.New("permission denied")
	// ErrMFARequired means the password was right and the second factor is
	// still missing.
	ErrMFARequired = errors.New("second factor required")
	// ErrConflict is a rule that the request would break, such as removing an
	// organisation's last administrator.
	ErrConflict = errors.New("conflicting request")
)

// FieldError describes a single validation problem, tied to the input field
// that caused it.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// ValidationError aggregates every field-level problem found while validating
// one request, so the client is told about all of them at once rather than
// discovering them one round trip at a time.
type ValidationError struct {
	Fields []FieldError
}

// Add records a problem for the named field.
func (e *ValidationError) Add(field, message string) {
	e.Fields = append(e.Fields, FieldError{Field: field, Message: message})
}

// Addf records a problem using a format string.
func (e *ValidationError) Addf(field, format string, args ...any) {
	e.Add(field, fmt.Sprintf(format, args...))
}

// OrNil returns the error itself when problems were recorded, and a nil error
// otherwise. It lets validation helpers end with "return v.OrNil()".
func (e *ValidationError) OrNil() error {
	if len(e.Fields) == 0 {
		return nil
	}
	return e
}

func (e *ValidationError) Error() string {
	parts := make([]string, 0, len(e.Fields))
	for _, f := range e.Fields {
		parts = append(parts, f.Field+": "+f.Message)
	}
	return "validation failed: " + strings.Join(parts, "; ")
}

// Is reports ValidationError as an instance of ErrValidation, so callers can
// branch on errors.Is(err, domain.ErrValidation) without a type assertion.
func (e *ValidationError) Is(target error) bool {
	return target == ErrValidation
}
