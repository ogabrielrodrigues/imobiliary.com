package usecase

import (
	"context"
	"fmt"
	"log/slog"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// exportPageSize is how many documents are read per round trip while assembling
// an export. Large enough that an ordinary account finishes in one query, small
// enough that a heavy one never loads everything into memory at once.
const exportPageSize = 200

// Privacy implements the rights a data subject has over their own data.
//
// It sits apart from Identity and Documents because it is named after the
// obligation rather than the feature: erasure and portability cut across every
// repository, and collecting them here keeps the two operations that must stay
// exhaustive in one file where they can be read together.
type Privacy struct {
	owners    OwnerRepository
	templates TemplateRepository
	documents DocumentRepository
	batches   BatchRepository
	blobs     BlobStore
	logger    *slog.Logger
}

// PrivacyConfig collects the dependencies of the Privacy use case.
type PrivacyConfig struct {
	Owners    OwnerRepository
	Templates TemplateRepository
	Documents DocumentRepository
	Batches   BatchRepository
	Blobs     BlobStore
	Logger    *slog.Logger
}

// NewPrivacy wires the Privacy use case.
func NewPrivacy(cfg PrivacyConfig) *Privacy {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Privacy{
		owners:    cfg.Owners,
		templates: cfg.Templates,
		documents: cfg.Documents,
		batches:   cfg.Batches,
		blobs:     cfg.Blobs,
		logger:    logger,
	}
}

// AccountExport is everything the service holds for one office.
//
// The values a user typed into their documents travel in Documents[i].Data —
// they are the substance of the export, not an afterthought, because they are
// the personal data the service actually accumulates.
type AccountExport struct {
	ExportedAt time.Time
	Owner      *domain.Owner
	Templates  []TemplateExport
	Documents  []domain.Document
	// Batches are held too: a batch's name is text the account holder typed,
	// and it often names the people its documents are about.
	Batches []domain.Batch
}

// TemplateExport pairs a template with every version it has ever had.
type TemplateExport struct {
	Template domain.Template
	Versions []domain.TemplateVersion
	// Deleted reports a template hidden by a soft delete but still held.
	Deleted bool
}

// Export assembles everything held about an account.
//
// It deliberately includes templates that were "deleted": that delete only
// hides them, and an access request asks what is still held rather than what is
// still shown. Saying otherwise in an export would be a lie told in writing.
func (s *Privacy) Export(ctx context.Context, ownerID uuid.UUID, now time.Time) (*AccountExport, error) {
	owner, err := s.owners.ByID(ctx, ownerID)
	if err != nil {
		return nil, err
	}

	templates, err := s.templates.AllForOwner(ctx, ownerID)
	if err != nil {
		return nil, err
	}

	exported := make([]TemplateExport, 0, len(templates))
	for i := range templates {
		versions, err := s.templates.VersionsOf(ctx, ownerID, templates[i].ID)
		if err != nil {
			return nil, err
		}
		exported = append(exported, TemplateExport{
			Template: templates[i],
			Versions: versions,
			Deleted:  templates[i].DeletedAt != nil,
		})
	}

	var documents []domain.Document
	for offset := 0; ; offset += exportPageSize {
		page, err := s.documents.List(ctx, ownerID, domain.DocumentFilter{}, exportPageSize, offset)
		if err != nil {
			return nil, err
		}
		documents = append(documents, page...)
		if len(page) < exportPageSize {
			break
		}
	}

	var batches []domain.Batch
	if s.batches != nil {
		if batches, err = s.batches.AllForOwner(ctx, ownerID); err != nil {
			return nil, err
		}
	}

	return &AccountExport{
		ExportedAt: now.UTC(),
		Owner:      owner,
		Templates:  exported,
		Documents:  documents,
		Batches:    batches,
	}, nil
}

// Filename is the name an export is offered under.
func (e *AccountExport) Filename() string {
	return fmt.Sprintf("imobiliary-docs-%s.json", e.ExportedAt.Format("2006-01-02"))
}
