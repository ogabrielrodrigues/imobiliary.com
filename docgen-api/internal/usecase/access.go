package usecase

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/platform/token"
)

// Caller is who a request speaks for: a member of an office. OwnerID is the
// office, which owns everything a member creates.
type Caller struct {
	OwnerID          uuid.UUID
	UserID           uuid.UUID
	OrganizationName string
	Email            string
	Name             string
	Role             string
}

// TokenVerifier checks a token the platform issued for this service.
type TokenVerifier interface {
	Verify(raw string) (*token.Identity, error)
}

// OwnerRepository stores the owners of templates, documents and batches.
type OwnerRepository interface {
	ByID(ctx context.Context, id uuid.UUID) (*domain.Owner, error)
	// EnsureOrganization records an office, or refreshes its name.
	EnsureOrganization(ctx context.Context, id uuid.UUID, name string, at time.Time) error
	// ClaimLegacy moves the rows of the legacy account with this e-mail to the
	// office, in one transaction, reporting whether there was one to move. An
	// account already moved is not moved again.
	ClaimLegacy(ctx context.Context, email string, organizationID uuid.UUID, at time.Time) (bool, error)
}

// Access resolves the caller of a request from its token (PLANO-FASE-7.md §4).
type Access struct {
	verifier TokenVerifier
	owners   OwnerRepository
	now      Clock
	logger   *slog.Logger
	// settled remembers the offices and e-mails already recorded and claimed
	// in this process, so an ordinary request does no write.
	settled sync.Map
}

// AccessConfig collects the dependencies.
type AccessConfig struct {
	Verifier TokenVerifier
	Owners   OwnerRepository
	Now      Clock
	Logger   *slog.Logger
}

// NewAccess wires the use case.
func NewAccess(cfg AccessConfig) *Access {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Access{verifier: cfg.Verifier, owners: cfg.Owners, now: cfg.Now, logger: cfg.Logger}
}

// Authenticate verifies a token and makes sure its office exists here. The
// first time an e-mail is seen, the legacy account with that e-mail, if any,
// moves to the office.
func (a *Access) Authenticate(ctx context.Context, raw string) (*Caller, error) {
	id, err := a.verifier.Verify(raw)
	if err != nil {
		return nil, fmt.Errorf("authenticate: %w", token.ErrInvalidToken)
	}
	key := id.OrganizationID.String() + "|" + id.OrganizationName + "|" + id.Email
	if _, done := a.settled.Load(key); !done {
		now := a.now().UTC()
		if err := a.owners.EnsureOrganization(ctx, id.OrganizationID, id.OrganizationName, now); err != nil {
			return nil, err
		}
		moved, err := a.owners.ClaimLegacy(ctx, id.Email, id.OrganizationID, now)
		if err != nil {
			return nil, err
		}
		if moved {
			a.logger.Info("legacy account moved to an office",
				slog.String("organization_id", id.OrganizationID.String()))
		}
		a.settled.Store(key, struct{}{})
	}
	return &Caller{
		OwnerID: id.OrganizationID, UserID: id.UserID, OrganizationName: id.OrganizationName,
		Email: id.Email, Name: id.Name, Role: id.Role,
	}, nil
}

// Owner reads the caller's office.
func (a *Access) Owner(ctx context.Context, caller *Caller) (*domain.Owner, error) {
	return a.owners.ByID(ctx, caller.OwnerID)
}
