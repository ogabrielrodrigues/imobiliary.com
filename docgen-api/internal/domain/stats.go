package domain

import "uuid"

// TemplateUsage counts the documents generated from one template.
//
// A template deleted since keeps its documents, so it can still rank; Deleted
// says so, and its name is kept for the same reason the documents are: they
// were made from it and would otherwise be unexplained.
type TemplateUsage struct {
	TemplateID uuid.UUID
	Name       string
	Deleted    bool
	Documents  int
}
