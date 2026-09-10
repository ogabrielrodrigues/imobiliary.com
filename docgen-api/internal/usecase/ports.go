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

// UserRepository stores accounts.
type UserRepository interface {
	Create(ctx context.Context, u *domain.User) error
	ByEmail(ctx context.Context, email string) (*domain.User, error)
	ByID(ctx context.Context, id uuid.UUID) (*domain.User, error)
	// Delete erases the account and everything cascading from it, reporting
	// the blob hashes no surviving row refers to any more.
	Delete(ctx context.Context, id uuid.UUID) ([]string, error)
}

// SessionRepository stores refresh tokens and the links between them.
type SessionRepository interface {
	Create(ctx context.Context, t *domain.RefreshToken) error
	ByHash(ctx context.Context, hash []byte) (*domain.RefreshToken, error)
	// Rotate consumes a token and stores its successor atomically, reporting
	// domain.ErrSessionReused when the token was already consumed.
	Rotate(ctx context.Context, oldID uuid.UUID, usedAt time.Time, next *domain.RefreshToken) error
	Revoke(ctx context.Context, id uuid.UUID, at time.Time) error
	RevokeAllForUser(ctx context.Context, userID uuid.UUID, at time.Time) error
}

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
	List(ctx context.Context, ownerID uuid.UUID, limit, offset int) ([]domain.Document, error)
	// Delete removes one document, reporting its blob hash when nothing else
	// refers to it. An empty hash means the file must stay.
	Delete(ctx context.Context, ownerID, id uuid.UUID) (string, error)
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

// PasswordHasher hides the choice of key derivation function.
type PasswordHasher interface {
	Hash(plain string) (string, error)
	Verify(plain, encoded string) error
}

// TokenIssuer mints and validates access tokens.
type TokenIssuer interface {
	IssueAccess(userID uuid.UUID) (string, time.Time, error)
	ParseAccess(raw string) (uuid.UUID, error)
}

// Clock supplies the current time. Injecting it keeps expiry and rotation
// testable without sleeping.
type Clock func() time.Time
