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
	users     UserRepository
	templates TemplateRepository
	documents DocumentRepository
	blobs     BlobStore
	logger    *slog.Logger
}

// PrivacyConfig collects the dependencies of the Privacy use case.
type PrivacyConfig struct {
	Users     UserRepository
	Templates TemplateRepository
	Documents DocumentRepository
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
		users:     cfg.Users,
		templates: cfg.Templates,
		documents: cfg.Documents,
		blobs:     cfg.Blobs,
		logger:    logger,
	}
}

// AccountExport is everything the service holds about one account.
//
// The values a user typed into their documents travel in Documents[i].Data —
// they are the substance of the export, not an afterthought, because they are
// the personal data the service actually accumulates.
type AccountExport struct {
	ExportedAt time.Time
	User       *domain.User
	Templates  []TemplateExport
	Documents  []domain.Document
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
func (s *Privacy) Export(ctx context.Context, userID uuid.UUID, now time.Time) (*AccountExport, error) {
	user, err := s.users.ByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	templates, err := s.templates.AllForOwner(ctx, userID)
	if err != nil {
		return nil, err
	}

	exported := make([]TemplateExport, 0, len(templates))
	for i := range templates {
		versions, err := s.templates.VersionsOf(ctx, userID, templates[i].ID)
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
		page, err := s.documents.List(ctx, userID, exportPageSize, offset)
		if err != nil {
			return nil, err
		}
		documents = append(documents, page...)
		if len(page) < exportPageSize {
			break
		}
	}

	return &AccountExport{
		ExportedAt: now.UTC(),
		User:       user,
		Templates:  exported,
		Documents:  documents,
	}, nil
}

// DeleteAccount erases an account and everything belonging to it.
//
// This is a real delete, unlike the one templates get: the rows go, the
// cascades fire, and the stored files go with them. It is what makes article
// 18 VI exercisable rather than merely promised.
//
// The database transaction commits before any file is touched, and it reports
// which hashes nothing refers to any more. Removing files first would leave a
// live row pointing at a missing body; removing them after means a crash in
// between leaks a file rather than breaking a record — the safer of the two
// failures, and the one a later sweep can still clean up.
func (s *Privacy) DeleteAccount(ctx context.Context, userID uuid.UUID) error {
	orphaned, err := s.users.Delete(ctx, userID)
	if err != nil {
		return err
	}

	for _, hash := range orphaned {
		if err := s.blobs.Delete(hash); err != nil {
			// The account is already gone; refusing the whole request now would
			// tell the user their data survived when most of it did not. The
			// leftover file is logged so it can be swept.
			s.logger.Error("could not erase stored file after account deletion",
				slog.String("hash", hash), slog.Any("error", err))
		}
	}
	return nil
}

// Filename is the name an export is offered under.
func (e *AccountExport) Filename() string {
	return fmt.Sprintf("imobiliary-docs-%s.json", e.ExportedAt.Format("2006-01-02"))
}
