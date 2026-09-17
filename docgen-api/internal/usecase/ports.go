// Package usecase holds the application's operations and the interfaces they
// depend on.
//
// Those interfaces are declared here, in the consumer, rather than next to the
// implementations that satisfy them. That is the Go idiom, and it is what gives
// the dependency inversion this design relies on: the adapters in
// internal/adapter know nothing about this package, yet plug into it. Keeping
// each interface to the handful of methods one use case actually calls is
// interface segregation in practice, and it makes the test fakes small enough
// to be written by hand.
package usecase

import (
	"context"
	"io"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// TemplateRepository stores templates and their immutable versions. Every
// method takes the owner, because ownership is enforced in the query.
type TemplateRepository interface {
	Create(ctx context.Context, t *domain.Template, v *domain.TemplateVersion) error
	AddVersion(ctx context.Context, ownerID uuid.UUID, v *domain.TemplateVersion) error
	ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.Template, error)
	List(ctx context.Context, ownerID uuid.UUID, limit, offset int) ([]domain.Template, error)
	SoftDelete(ctx context.Context, ownerID, id uuid.UUID, at time.Time) error
	LatestVersion(ctx context.Context, ownerID, templateID uuid.UUID) (*domain.TemplateVersion, error)
	Version(ctx context.Context, ownerID, templateID uuid.UUID, version int) (*domain.TemplateVersion, error)
	Versions(ctx context.Context, ownerID, templateID uuid.UUID, limit, offset int) ([]domain.TemplateVersion, error)
	// AllForOwner and VersionsOf ignore the soft delete, because an access
	// request asks what is still held rather than what is still shown.
	AllForOwner(ctx context.Context, ownerID uuid.UUID) ([]domain.Template, error)
	VersionsOf(ctx context.Context, ownerID, templateID uuid.UUID) ([]domain.TemplateVersion, error)
}

// DocumentRepository stores the metadata of generated documents.
type DocumentRepository interface {
	Create(ctx context.Context, d *domain.Document) error
	ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.Document, error)
	List(ctx context.Context, ownerID uuid.UUID, filter domain.DocumentFilter, limit, offset int) ([]domain.Document, error)
	// Delete removes one document, reporting its blob hash when nothing else
	// refers to it. An empty hash means the file must stay.
	Delete(ctx context.Context, ownerID, id uuid.UUID) (string, error)
}

// BatchRepository stores batches of documents generated together.
type BatchRepository interface {
	Create(ctx context.Context, b *domain.Batch) error
	ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.BatchSummary, error)
	// AllForOwner returns every batch of an account, for the data export.
	AllForOwner(ctx context.Context, ownerID uuid.UUID) ([]domain.Batch, error)
	// Delete removes a batch and the documents in it, reporting the blob
	// hashes nothing refers to any more.
	Delete(ctx context.Context, ownerID, id uuid.UUID) ([]string, error)
	// History returns documents generated on their own and batches, mixed,
	// newest first, optionally narrowed to one template.
	History(ctx context.Context, ownerID uuid.UUID, templateID *uuid.UUID, limit, offset int) ([]domain.HistoryEntry, error)
}

// StatsRepository answers the aggregate questions behind an account's
// dashboard. Every method is scoped to one owner in the query.
type StatsRepository interface {
	CountActiveTemplates(ctx context.Context, ownerID uuid.UUID) (int, error)
	CountDocuments(ctx context.Context, ownerID uuid.UUID) (int, error)
	// DocumentTimesSince returns when each document created at or after since
	// was generated. Grouping them into days is left to the caller, because a
	// day depends on the time zone and the database stores UTC.
	DocumentTimesSince(ctx context.Context, ownerID uuid.UUID, since time.Time) ([]time.Time, error)
	// TopTemplatesSince ranks templates by the documents generated from them at
	// or after since, most first, ties broken by name.
	TopTemplatesSince(ctx context.Context, ownerID uuid.UUID, since time.Time, limit int) ([]domain.TemplateUsage, error)
}

// BlobStore keeps the DOCX bytes, addressed by content hash.
type BlobStore interface {
	Put(r io.Reader) (hash string, size int64, err error)
	ReadAll(hash string) ([]byte, error)
	Open(hash string) (io.ReadSeekCloser, error)
	// Delete removes a stored object. The caller must have established that
	// nothing refers to it: content addressing means one file can be the body
	// of rows belonging to several accounts.
	Delete(hash string) error
}

// Clock supplies the current time. Injecting it keeps expiry and rotation
// testable without sleeping.
type Clock func() time.Time
