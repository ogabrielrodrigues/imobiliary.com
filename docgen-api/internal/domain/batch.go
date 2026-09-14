package domain

import (
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// MaxBatchNameLength bounds a batch's name, in characters, like a template's.
const MaxBatchNameLength = 120

// Batch is a set of documents generated together from one template version,
// typically one per row of a spreadsheet.
type Batch struct {
	ID                uuid.UUID
	OwnerID           uuid.UUID
	TemplateID        uuid.UUID
	TemplateVersionID uuid.UUID
	TemplateVersion   int
	Name              string
	CreatedAt         time.Time
}

// BatchSummary is a batch together with what it holds so far.
type BatchSummary struct {
	Batch
	Documents int
	Size      int64
}

// HistoryEntry is one row of an account's generation history: either a
// document generated on its own, or a batch. Exactly one field is set.
type HistoryEntry struct {
	Document *Document
	Batch    *BatchSummary
}

// DocumentFilter narrows a listing of documents. A nil field does not filter.
type DocumentFilter struct {
	TemplateID *uuid.UUID
	BatchID    *uuid.UUID
}

// ValidateBatchName checks a batch's name, which is shown in the history and
// names the archive a batch downloads as.
func ValidateBatchName(name string) error {
	v := &ValidationError{}
	trimmed := strings.TrimSpace(name)
	switch {
	case trimmed == "":
		v.Add("name", "is required")
	case utf8.RuneCountInString(trimmed) > MaxBatchNameLength:
		v.Addf("name", "must be at most %d characters", MaxBatchNameLength)
	}
	return v.OrNil()
}
