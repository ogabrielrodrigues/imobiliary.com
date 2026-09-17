package domain

import (
	"time"
	"unicode"
	"unicode/utf8"
	"uuid"
)

// MaxDocumentDataValueLength bounds a single substituted value, so one request
// cannot inflate the rendered document without limit.
const MaxDocumentDataValueLength = 10000

// Document is a rendered DOCX. It records the exact template version and the
// input data used, which together make the output reproducible.
type Document struct {
	ID                uuid.UUID
	OwnerID           uuid.UUID
	TemplateID        uuid.UUID
	TemplateVersionID uuid.UUID
	TemplateVersion   int
	Filename          string
	BlobHash          string
	Size              int64
	Data              map[string]string
	CreatedAt         time.Time
	// BatchID is the batch the document was generated in, or nil for one
	// generated on its own.
	BatchID *uuid.UUID
	// Reference ties the document to a record elsewhere, such as
	// "contract:<id>" on the Imobiliary platform. Empty when there is none.
	Reference string
}

// MaxReferenceLength bounds a document's reference.
const MaxReferenceLength = 100

// ValidateReference checks a document's reference: at most 100 characters,
// none of them a control character.
func ValidateReference(reference string) error {
	v := &ValidationError{}
	if utf8.RuneCountInString(reference) > MaxReferenceLength {
		v.Add("reference", "must be at most 100 characters")
	}
	for _, r := range reference {
		if unicode.IsControl(r) {
			v.Add("reference", "must not contain control characters")
			break
		}
	}
	return v.OrNil()
}

// ValidateDocumentData checks the supplied values against the placeholder
// schema of a template version.
//
// Unknown fields are rejected rather than ignored: silently dropping a
// misspelled key would produce a document that is missing content the caller
// believed it had supplied.
func ValidateDocumentData(placeholders []string, data map[string]string) error {
	v := &ValidationError{}

	known := make(map[string]struct{}, len(placeholders))
	for _, name := range placeholders {
		known[name] = struct{}{}
		if _, ok := data[name]; !ok {
			v.Addf("data."+name, "is required by the template")
		}
	}
	for name, value := range data {
		if _, ok := known[name]; !ok {
			v.Addf("data."+name, "is not used by this template version")
			continue
		}
		if len(value) > MaxDocumentDataValueLength {
			v.Addf("data."+name, "must be at most %d bytes", MaxDocumentDataValueLength)
		}
	}
	return v.OrNil()
}
