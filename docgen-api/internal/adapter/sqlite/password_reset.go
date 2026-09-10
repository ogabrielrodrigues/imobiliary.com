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

// PasswordResetRepository stores the one-time tokens that authorise setting a
// password without knowing the old one. Only the digest of a secret is kept, so
// a leak of this table hands out nothing usable.
type PasswordResetRepository struct {
	db *DB
}

// NewPasswordResetRepository returns a repository backed by db.
func NewPasswordResetRepository(db *DB) *PasswordResetRepository {
	return &PasswordResetRepository{db: db}
}

const passwordResetColumns = "id, user_id, token_hash, expires_at, created_at, used_at"

// Create records a new token.
func (r *PasswordResetRepository) Create(ctx context.Context, reset *domain.PasswordReset) error {
	const query = `INSERT INTO password_resets (` + passwordResetColumns + `) VALUES (?, ?, ?, ?, ?, ?)`

	_, err := r.db.write.ExecContext(ctx, query,
		idOf(reset.ID), idOf(reset.UserID), reset.TokenHash,
		formatTime(reset.ExpiresAt), formatTime(reset.CreatedAt), nil,
	)
	if err != nil {
		return fmt.Errorf("sqlite: create password reset: %w", err)
	}
	return nil
}

// ByHash looks a token up by the digest of its secret.
func (r *PasswordResetRepository) ByHash(ctx context.Context, hash []byte) (*domain.PasswordReset, error) {
	const query = `SELECT ` + passwordResetColumns + ` FROM password_resets WHERE token_hash = ?`

	return scanPasswordReset(r.db.read.QueryRowContext(ctx, query, hash))
}

// Consume marks a token used.
//
// The update is conditional on it still being unused, so two requests racing
// the same link cannot both proceed: exactly one changes a row, and the loser
// is told the token is unknown — which, as a permission, it now is.
func (r *PasswordResetRepository) Consume(ctx context.Context, id uuid.UUID, at time.Time) error {
	const query = `UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL`

	result, err := r.db.write.ExecContext(ctx, query, formatTime(at), idOf(id))
	if err != nil {
		return fmt.Errorf("sqlite: consume password reset: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("sqlite: consume password reset: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("password reset: %w", domain.ErrNotFound)
	}
	return nil
}

// InvalidateForUser spends every outstanding token of an account. It is what a
// completed reset, or any password change, does to the links still sitting in
// an inbox.
func (r *PasswordResetRepository) InvalidateForUser(ctx context.Context, userID uuid.UUID, at time.Time) error {
	const query = `UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`

	if _, err := r.db.write.ExecContext(ctx, query, formatTime(at), idOf(userID)); err != nil {
		return fmt.Errorf("sqlite: invalidate password resets: %w", err)
	}
	return nil
}

// DeleteExpired removes tokens that can no longer be exchanged, keeping the
// table from growing without bound. Spent ones go too: once used_at is set the
// row proves nothing anybody needs.
func (r *PasswordResetRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	const query = `DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL`

	result, err := r.db.write.ExecContext(ctx, query, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("sqlite: delete expired password resets: %w", err)
	}
	return result.RowsAffected()
}

func scanPasswordReset(row rowScanner) (*domain.PasswordReset, error) {
	var (
		reset                domain.PasswordReset
		rawID, rawUserID     []byte
		expiresAt, createdAt string
		usedAt               *string
	)

	err := row.Scan(&rawID, &rawUserID, &reset.TokenHash, &expiresAt, &createdAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("password reset: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan password reset: %w", err)
	}

	if reset.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	if reset.UserID, err = idFrom(rawUserID); err != nil {
		return nil, err
	}
	if reset.ExpiresAt, err = parseTime(expiresAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse password reset expires_at: %w", err)
	}
	if reset.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse password reset created_at: %w", err)
	}
	if usedAt != nil {
		at, err := parseTime(*usedAt)
		if err != nil {
			return nil, fmt.Errorf("sqlite: parse password reset used_at: %w", err)
		}
		reset.UsedAt = &at
	}
	return &reset, nil
}
