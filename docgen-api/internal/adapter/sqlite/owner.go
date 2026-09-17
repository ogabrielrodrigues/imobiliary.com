package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// OwnerRepository stores the owners of templates, documents and batches.
type OwnerRepository struct {
	db *DB
}

// NewOwnerRepository returns a repository backed by db.
func NewOwnerRepository(db *DB) *OwnerRepository {
	return &OwnerRepository{db: db}
}

// ByID reads one owner.
func (r *OwnerRepository) ByID(ctx context.Context, id uuid.UUID) (*domain.Owner, error) {
	var (
		o                 domain.Owner
		rawID, mergedInto []byte
		kind, created     string
		email, mergedAt   sql.NullString
	)
	err := r.db.read.QueryRowContext(ctx,
		`SELECT id, kind, name, email, merged_into, merged_at, created_at FROM owners WHERE id = ?`, idOf(id),
	).Scan(&rawID, &kind, &o.Name, &email, &mergedInto, &mergedAt, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("owner: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: owner: %w", err)
	}
	if o.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	o.Kind, o.Email = domain.OwnerKind(kind), email.String
	if mergedInto != nil {
		into, err := idFrom(mergedInto)
		if err != nil {
			return nil, err
		}
		o.MergedInto = &into
	}
	if o.MergedAt, err = parseNullTime(mergedAt); err != nil {
		return nil, err
	}
	if o.CreatedAt, err = parseTime(created); err != nil {
		return nil, err
	}
	return &o, nil
}

// EnsureOrganization records an office, or refreshes its name when it changed.
func (r *OwnerRepository) EnsureOrganization(ctx context.Context, id uuid.UUID, name string, at time.Time) error {
	_, err := r.db.write.ExecContext(ctx,
		`INSERT INTO owners (id, kind, name, created_at) VALUES (?, 'organization', ?, ?)
		 ON CONFLICT (id) DO UPDATE SET name = excluded.name WHERE owners.name <> excluded.name`,
		idOf(id), name, formatTime(at))
	if err != nil {
		return fmt.Errorf("sqlite: ensure organization: %w", err)
	}
	return nil
}

// ClaimLegacy moves a legacy account's templates, documents and batches to an
// office, in one transaction.
func (r *OwnerRepository) ClaimLegacy(ctx context.Context, email string, organizationID uuid.UUID, at time.Time) (bool, error) {
	moved := false
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var legacy []byte
		err := tx.QueryRowContext(ctx,
			`SELECT id FROM owners WHERE kind = 'legacy_account' AND email = ? AND merged_into IS NULL`,
			domain.NormalizeEmail(email)).Scan(&legacy)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("sqlite: find legacy account: %w", err)
		}
		org := idOf(organizationID)
		for _, table := range []string{"templates", "batches", "documents"} {
			// The table name comes from the fixed list above, never from input.
			if _, err := tx.ExecContext(ctx, "UPDATE "+table+" SET owner_id = ? WHERE owner_id = ?", org, legacy); err != nil {
				return fmt.Errorf("sqlite: move %s: %w", table, err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE owners SET merged_into = ?, merged_at = ? WHERE id = ?`, org, formatTime(at), legacy); err != nil {
			return fmt.Errorf("sqlite: mark legacy account merged: %w", err)
		}
		moved = true
		return nil
	})
	return moved, err
}
