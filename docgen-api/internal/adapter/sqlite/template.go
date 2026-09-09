package sqlite

import (
	"context"
	"database/sql"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// TemplateRepository stores templates and their immutable versions.
type TemplateRepository struct {
	db *DB
}

// NewTemplateRepository returns a repository backed by db.
func NewTemplateRepository(db *DB) *TemplateRepository {
	return &TemplateRepository{db: db}
}

const (
	templateColumns = "id, owner_id, name, description, latest_version, created_at, updated_at"
	versionColumns  = "id, template_id, version, blob_hash, size, placeholders, created_at"
)

// Create stores a new template together with its first version.
//
// Both rows are written in one transaction: a template whose latest_version
// pointed at a version that was never inserted would be unusable.
func (r *TemplateRepository) Create(ctx context.Context, t *domain.Template, v *domain.TemplateVersion) error {
	const insertTemplate = `INSERT INTO templates (` + templateColumns + `) VALUES (?, ?, ?, ?, ?, ?, ?)`

	placeholders, err := json.Marshal(v.Placeholders)
	if err != nil {
		return fmt.Errorf("sqlite: encode placeholders: %w", err)
	}

	return r.db.withTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, insertTemplate,
			idOf(t.ID), idOf(t.OwnerID), t.Name, t.Description, t.LatestVersion,
			formatTime(t.CreatedAt), formatTime(t.UpdatedAt),
		)
		if err != nil {
			return fmt.Errorf("sqlite: create template: %w", err)
		}
		return insertVersion(ctx, tx, v, placeholders)
	})
}

// AddVersion appends a new version to an existing template and returns it.
//
// The version number is allocated inside the transaction, so two concurrent
// uploads cannot be handed the same number.
func (r *TemplateRepository) AddVersion(ctx context.Context, ownerID uuid.UUID, v *domain.TemplateVersion) error {
	const lockTemplate = `SELECT latest_version FROM templates WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`
	const bumpTemplate = `UPDATE templates SET latest_version = ?, updated_at = ? WHERE id = ?`

	placeholders, err := json.Marshal(v.Placeholders)
	if err != nil {
		return fmt.Errorf("sqlite: encode placeholders: %w", err)
	}

	return r.db.withTx(ctx, func(tx *sql.Tx) error {
		var latest int
		err := tx.QueryRowContext(ctx, lockTemplate, idOf(v.TemplateID), idOf(ownerID)).Scan(&latest)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("template: %w", domain.ErrNotFound)
		}
		if err != nil {
			return fmt.Errorf("sqlite: read template: %w", err)
		}

		v.Version = latest + 1
		if err := insertVersion(ctx, tx, v, placeholders); err != nil {
			return err
		}

		_, err = tx.ExecContext(ctx, bumpTemplate, v.Version, formatTime(v.CreatedAt), idOf(v.TemplateID))
		if err != nil {
			return fmt.Errorf("sqlite: update template version pointer: %w", err)
		}
		return nil
	})
}

func insertVersion(ctx context.Context, tx *sql.Tx, v *domain.TemplateVersion, placeholders []byte) error {
	const query = `INSERT INTO template_versions (` + versionColumns + `) VALUES (?, ?, ?, ?, ?, ?, ?)`

	_, err := tx.ExecContext(ctx, query,
		idOf(v.ID), idOf(v.TemplateID), v.Version, v.BlobHash, v.Size,
		string(placeholders), formatTime(v.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("sqlite: create template version: %w", err)
	}
	return nil
}

// ByID returns one template owned by ownerID.
//
// Ownership is part of the query rather than a check performed afterwards, so
// there is no code path in which a caller can forget to apply it.
func (r *TemplateRepository) ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.Template, error) {
	const query = `SELECT ` + templateColumns + ` FROM templates
		WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`

	return scanTemplateRow(r.db.read.QueryRowContext(ctx, query, idOf(id), idOf(ownerID)))
}

// List returns a page of the templates owned by ownerID, newest first.
func (r *TemplateRepository) List(ctx context.Context, ownerID uuid.UUID, limit, offset int) ([]domain.Template, error) {
	const query = `SELECT ` + templateColumns + ` FROM templates
		WHERE owner_id = ? AND deleted_at IS NULL
		ORDER BY id DESC LIMIT ? OFFSET ?`

	rows, err := r.db.read.QueryContext(ctx, query, idOf(ownerID), limit, offset)
	if err != nil {
		return nil, fmt.Errorf("sqlite: list templates: %w", err)
	}
	defer rows.Close()

	var out []domain.Template
	for rows.Next() {
		t, err := scanTemplateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list templates: %w", err)
	}
	return out, nil
}

// SoftDelete hides a template without discarding the versions that generated
// documents still refer to.
func (r *TemplateRepository) SoftDelete(ctx context.Context, ownerID, id uuid.UUID, at time.Time) error {
	const query = `UPDATE templates SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`

	stamp := formatTime(at)
	result, err := r.db.write.ExecContext(ctx, query, stamp, stamp, idOf(id), idOf(ownerID))
	if err != nil {
		return fmt.Errorf("sqlite: delete template: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("sqlite: delete template: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("template: %w", domain.ErrNotFound)
	}
	return nil
}

// LatestVersion returns the newest version of a template owned by ownerID.
func (r *TemplateRepository) LatestVersion(ctx context.Context, ownerID, templateID uuid.UUID) (*domain.TemplateVersion, error) {
	const query = `SELECT v.id, v.template_id, v.version, v.blob_hash, v.size, v.placeholders, v.created_at
		FROM template_versions v
		JOIN templates t ON t.id = v.template_id
		WHERE v.template_id = ? AND t.owner_id = ? AND t.deleted_at IS NULL
		ORDER BY v.version DESC LIMIT 1`

	return scanVersion(r.db.read.QueryRowContext(ctx, query, idOf(templateID), idOf(ownerID)))
}

// Version returns one specific version of a template owned by ownerID.
func (r *TemplateRepository) Version(ctx context.Context, ownerID, templateID uuid.UUID, version int) (*domain.TemplateVersion, error) {
	const query = `SELECT v.id, v.template_id, v.version, v.blob_hash, v.size, v.placeholders, v.created_at
		FROM template_versions v
		JOIN templates t ON t.id = v.template_id
		WHERE v.template_id = ? AND t.owner_id = ? AND v.version = ? AND t.deleted_at IS NULL`

	return scanVersion(r.db.read.QueryRowContext(ctx, query, idOf(templateID), idOf(ownerID), version))
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanTemplateRow(row rowScanner) (*domain.Template, error) {
	var (
		t                    domain.Template
		rawID, rawOwnerID    []byte
		createdAt, updatedAt string
	)

	err := row.Scan(&rawID, &rawOwnerID, &t.Name, &t.Description, &t.LatestVersion, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("template: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan template: %w", err)
	}

	if t.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	if t.OwnerID, err = idFrom(rawOwnerID); err != nil {
		return nil, err
	}
	if t.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse template created_at: %w", err)
	}
	if t.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse template updated_at: %w", err)
	}
	return &t, nil
}

func scanVersion(row *sql.Row) (*domain.TemplateVersion, error) {
	var (
		v                       domain.TemplateVersion
		rawID, rawTemplateID    []byte
		placeholders, createdAt string
	)

	err := row.Scan(&rawID, &rawTemplateID, &v.Version, &v.BlobHash, &v.Size, &placeholders, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("template version: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan template version: %w", err)
	}

	if v.ID, err = idFrom(rawID); err != nil {
		return nil, err
	}
	if v.TemplateID, err = idFrom(rawTemplateID); err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(placeholders), &v.Placeholders); err != nil {
		return nil, fmt.Errorf("sqlite: decode placeholders: %w", err)
	}
	if v.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse template version created_at: %w", err)
	}
	return &v, nil
}
