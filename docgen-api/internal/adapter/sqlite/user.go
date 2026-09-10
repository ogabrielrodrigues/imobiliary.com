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

// UserRepository stores accounts.
type UserRepository struct {
	db *DB
}

// NewUserRepository returns a repository backed by db.
func NewUserRepository(db *DB) *UserRepository {
	return &UserRepository{db: db}
}

const userColumns = "id, email, name, password_hash, created_at, updated_at, " +
	"terms_accepted_at, terms_version, password_changed_at"

// Create inserts a new account, reporting domain.ErrAlreadyExists when the
// email is taken.
func (r *UserRepository) Create(ctx context.Context, u *domain.User) error {
	// password_changed_at is absent from the insert on purpose: a new account
	// has not changed its password, and writing its creation time here would be
	// recording an event that did not happen.
	const query = `INSERT INTO users (id, email, name, password_hash, created_at,
		updated_at, terms_accepted_at, terms_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	var acceptedAt *string
	if u.TermsAcceptedAt != nil {
		stamp := formatTime(*u.TermsAcceptedAt)
		acceptedAt = &stamp
	}

	_, err := r.db.write.ExecContext(ctx, query,
		idOf(u.ID), u.Email, u.Name, u.PasswordHash,
		formatTime(u.CreatedAt), formatTime(u.UpdatedAt),
		acceptedAt, u.TermsVersion,
	)
	if isUniqueViolation(err) {
		return fmt.Errorf("create user: %w", domain.ErrAlreadyExists)
	}
	if err != nil {
		return fmt.Errorf("sqlite: create user: %w", err)
	}
	return nil
}

// ByEmail looks an account up by its normalized address.
func (r *UserRepository) ByEmail(ctx context.Context, email string) (*domain.User, error) {
	const query = `SELECT ` + userColumns + ` FROM users WHERE email = ?`
	return scanUser(r.db.read.QueryRowContext(ctx, query, email))
}

// ByID looks an account up by identifier.
func (r *UserRepository) ByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
	const query = `SELECT ` + userColumns + ` FROM users WHERE id = ?`
	return scanUser(r.db.read.QueryRowContext(ctx, query, idOf(id)))
}

func scanUser(row *sql.Row) (*domain.User, error) {
	var (
		u                    domain.User
		rawID                []byte
		createdAt, updatedAt string
		acceptedAt           *string
		termsVersion         *string
		passwordChangedAt    *string
	)

	err := row.Scan(&rawID, &u.Email, &u.Name, &u.PasswordHash, &createdAt, &updatedAt,
		&acceptedAt, &termsVersion, &passwordChangedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("user: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan user: %w", err)
	}

	if u.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	if u.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse user created_at: %w", err)
	}
	if u.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse user updated_at: %w", err)
	}
	// Both stay unset on an account that predates the terms requirement, which
	// is the honest record of one that was never asked.
	if acceptedAt != nil {
		at, err := parseTime(*acceptedAt)
		if err != nil {
			return nil, fmt.Errorf("sqlite: parse user terms_accepted_at: %w", err)
		}
		u.TermsAcceptedAt = &at
	}
	if termsVersion != nil {
		u.TermsVersion = *termsVersion
	}
	if passwordChangedAt != nil {
		at, err := parseTime(*passwordChangedAt)
		if err != nil {
			return nil, fmt.Errorf("sqlite: parse user password_changed_at: %w", err)
		}
		u.PasswordChangedAt = &at
	}
	return &u, nil
}

// SessionRepository stores refresh tokens.
type SessionRepository struct {
	db *DB
}

// NewSessionRepository returns a repository backed by db.
func NewSessionRepository(db *DB) *SessionRepository {
	return &SessionRepository{db: db}
}

const sessionColumns = "id, user_id, token_hash, parent_id, expires_at, created_at, used_at, revoked_at"

// Create stores a freshly issued refresh token.
func (r *SessionRepository) Create(ctx context.Context, t *domain.RefreshToken) error {
	const query = `INSERT INTO refresh_tokens (` + sessionColumns + `) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.write.ExecContext(ctx, query,
		idOf(t.ID), idOf(t.UserID), t.TokenHash, nullID(t.ParentID),
		formatTime(t.ExpiresAt), formatTime(t.CreatedAt),
		formatNullTime(t.UsedAt), formatNullTime(t.RevokedAt),
	)
	if err != nil {
		return fmt.Errorf("sqlite: create refresh token: %w", err)
	}
	return nil
}

// ByHash finds a refresh token by the digest of its secret.
func (r *SessionRepository) ByHash(ctx context.Context, hash []byte) (*domain.RefreshToken, error) {
	const query = `SELECT ` + sessionColumns + ` FROM refresh_tokens WHERE token_hash = ?`

	var (
		t                    domain.RefreshToken
		rawID, rawUserID     []byte
		rawParentID          []byte
		expiresAt, createdAt string
		usedAt, revokedAt    sql.NullString
	)

	err := r.db.read.QueryRowContext(ctx, query, hash).Scan(
		&rawID, &rawUserID, &t.TokenHash, &rawParentID,
		&expiresAt, &createdAt, &usedAt, &revokedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("refresh token: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan refresh token: %w", err)
	}

	if t.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	if t.UserID, err = idFrom(rawUserID); err != nil {
		return nil, err
	}
	if rawParentID != nil {
		parentID, err := idFrom(rawParentID)
		if err != nil {
			return nil, err
		}
		t.ParentID = &parentID
	}
	if t.ExpiresAt, err = parseTime(expiresAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse refresh token expires_at: %w", err)
	}
	if t.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse refresh token created_at: %w", err)
	}
	if t.UsedAt, err = parseNullTime(usedAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse refresh token used_at: %w", err)
	}
	if t.RevokedAt, err = parseNullTime(revokedAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse refresh token revoked_at: %w", err)
	}
	return &t, nil
}

// Rotate consumes a refresh token and stores its successor atomically.
//
// The update is conditional on the token still being unused, so two requests
// racing with the same secret cannot both succeed: exactly one updates a row,
// and the loser is treated as a replay.
func (r *SessionRepository) Rotate(ctx context.Context, oldID uuid.UUID, usedAt time.Time, next *domain.RefreshToken) error {
	const consume = `UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`
	const insert = `INSERT INTO refresh_tokens (` + sessionColumns + `) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	return r.db.withTx(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, consume, formatTime(usedAt), idOf(oldID))
		if err != nil {
			return fmt.Errorf("sqlite: consume refresh token: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("sqlite: consume refresh token: %w", err)
		}
		if affected == 0 {
			return fmt.Errorf("rotate refresh token: %w", domain.ErrSessionReused)
		}

		_, err = tx.ExecContext(ctx, insert,
			idOf(next.ID), idOf(next.UserID), next.TokenHash, nullID(next.ParentID),
			formatTime(next.ExpiresAt), formatTime(next.CreatedAt),
			formatNullTime(next.UsedAt), formatNullTime(next.RevokedAt),
		)
		if err != nil {
			return fmt.Errorf("sqlite: store successor refresh token: %w", err)
		}
		return nil
	})
}

// RevokeAllForUser ends every live session of a user. It is the response to a
// replayed token, when it must be assumed that a secret has leaked and there is
// no way to tell the thief's chain from the owner's.
func (r *SessionRepository) RevokeAllForUser(ctx context.Context, userID uuid.UUID, at time.Time) error {
	const query = `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`

	if _, err := r.db.write.ExecContext(ctx, query, formatTime(at), idOf(userID)); err != nil {
		return fmt.Errorf("sqlite: revoke sessions: %w", err)
	}
	return nil
}

// Revoke ends a single session, which is what an explicit logout does.
func (r *SessionRepository) Revoke(ctx context.Context, id uuid.UUID, at time.Time) error {
	const query = `UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`

	if _, err := r.db.write.ExecContext(ctx, query, formatTime(at), idOf(id)); err != nil {
		return fmt.Errorf("sqlite: revoke session: %w", err)
	}
	return nil
}

// DeleteExpired removes refresh tokens that expired before the given instant,
// keeping the table from growing without bound.
func (r *SessionRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	const query = `DELETE FROM refresh_tokens WHERE expires_at < ?`

	result, err := r.db.write.ExecContext(ctx, query, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("sqlite: delete expired sessions: %w", err)
	}
	return result.RowsAffected()
}

// Delete erases an account and everything that belongs to it, reporting the
// blob hashes that no surviving row refers to any more.
//
// The foreign keys cascade from users to refresh_tokens, templates,
// template_versions and documents, so one statement clears the database side.
// The stored files are a different matter: content addressing means one file
// can be the body of rows belonging to several accounts, so the caller may only
// erase the hashes reported here, and only after this returns.
//
// The whole thing runs in one transaction, which is what makes the reference
// count trustworthy: no row can appear between counting and deleting.
func (r *UserRepository) Delete(ctx context.Context, id uuid.UUID) ([]string, error) {
	// Every hash this account's rows point at, before anything is removed.
	const mine = `SELECT v.blob_hash FROM template_versions v
			JOIN templates t ON t.id = v.template_id
			WHERE t.owner_id = ?
		UNION
		SELECT d.blob_hash FROM documents d WHERE d.owner_id = ?`

	const removeUser = `DELETE FROM users WHERE id = ?`

	var orphaned []string

	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		owner := idOf(id)

		hashes, err := collectHashes(ctx, tx, mine, owner, owner)
		if err != nil {
			return err
		}

		result, err := tx.ExecContext(ctx, removeUser, owner)
		if err != nil {
			return fmt.Errorf("sqlite: delete user: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("sqlite: delete user: %w", err)
		}
		if affected == 0 {
			return fmt.Errorf("user: %w", domain.ErrNotFound)
		}

		orphaned, err = unreferencedHashes(ctx, tx, hashes)
		return err
	})
	if err != nil {
		return nil, err
	}
	return orphaned, nil
}

// collectHashes runs a query returning a single blob_hash column.
func collectHashes(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: collect blob hashes: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			return nil, fmt.Errorf("sqlite: scan blob hash: %w", err)
		}
		out = append(out, hash)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: collect blob hashes: %w", err)
	}
	return out, nil
}

// unreferencedHashes returns those of the given hashes that no row points at.
//
// Asked one hash at a time rather than with an IN clause built from the slice:
// the list is short, the query is a two-index lookup, and a fixed statement
// cannot be malformed by an unusual length.
func unreferencedHashes(ctx context.Context, tx *sql.Tx, hashes []string) ([]string, error) {
	const referrers = `SELECT
		EXISTS (SELECT 1 FROM template_versions WHERE blob_hash = ?)
		OR EXISTS (SELECT 1 FROM documents WHERE blob_hash = ?)`

	var out []string
	for _, hash := range hashes {
		var referenced bool
		if err := tx.QueryRowContext(ctx, referrers, hash, hash).Scan(&referenced); err != nil {
			return nil, fmt.Errorf("sqlite: count blob references: %w", err)
		}
		if !referenced {
			out = append(out, hash)
		}
	}
	return out, nil
}

// UpdatePassword replaces the stored hash and records when it changed.
//
// The instant is what an access token is later compared against, so it is
// written in the same statement as the hash: a change recorded without it would
// leave tokens minted under the old password valid until they expired.
func (r *UserRepository) UpdatePassword(ctx context.Context, id uuid.UUID, hash string, at time.Time) error {
	const query = `UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?
		WHERE id = ?`

	stamp := formatTime(at)
	result, err := r.db.write.ExecContext(ctx, query, hash, stamp, stamp, idOf(id))
	if err != nil {
		return fmt.Errorf("sqlite: update password: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("sqlite: update password: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("user: %w", domain.ErrNotFound)
	}
	return nil
}
