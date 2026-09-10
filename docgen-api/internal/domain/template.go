package domain

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// Limits applied to uploaded templates. They bound both the memory a single
// request can cost and the blast radius of a malicious archive.
const (
	MaxTemplateNameLength        = 120
	MaxTemplateDescriptionLength = 500
	MaxPlaceholders              = 200
	MaxPlaceholderNameLength     = 64
)

// placeholderPattern constrains placeholder names to snake_case identifiers.
// Restricting the alphabet keeps names safe to echo back in error messages and
// rules out template expressions that reach for anything other than a plain
// data field.
var placeholderPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Template is the logical model a user owns. Its content lives in versions.
type Template struct {
	ID            uuid.UUID
	OwnerID       uuid.UUID
	Name          string
	Description   string
	LatestVersion int
	CreatedAt     time.Time
	UpdatedAt     time.Time
	// DeletedAt marks a template hidden by a soft delete. Every ordinary read
	// filters these out, so it is nil there; it is populated only where the
	// question is what is still held rather than what is still shown.
	DeletedAt *time.Time
}

// TemplateVersion is an immutable snapshot of an uploaded DOCX. Publishing a
// change creates a new version rather than mutating this one, which is what
// makes every generated document reproducible and lets the compiled template be
// cached in memory indefinitely.
type TemplateVersion struct {
	ID           uuid.UUID
	TemplateID   uuid.UUID
	Version      int
	BlobHash     string
	Size         int64
	Placeholders []string
	CreatedAt    time.Time
}

// ValidateTemplateMetadata checks the name and description supplied on upload.
func ValidateTemplateMetadata(name, description string) error {
	v := &ValidationError{}
	switch {
	case strings.TrimSpace(name) == "":
		v.Add("name", "is required")
	case utf8.RuneCountInString(name) > MaxTemplateNameLength:
		v.Addf("name", "must be at most %d characters", MaxTemplateNameLength)
	}
	if utf8.RuneCountInString(description) > MaxTemplateDescriptionLength {
		v.Addf("description", "must be at most %d characters", MaxTemplateDescriptionLength)
	}
	return v.OrNil()
}

// IsValidPlaceholderName reports whether a name discovered in a template is one
// this service is willing to expose as part of a version's schema.
func IsValidPlaceholderName(name string) bool {
	return len(name) <= MaxPlaceholderNameLength && placeholderPattern.MatchString(name)
}
