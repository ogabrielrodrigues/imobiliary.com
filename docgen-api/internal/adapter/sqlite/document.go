package sqlite

import (
	"context"
	"database/sql"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"uuid"

	"docgen/internal/domain"
)

// DocumentRepository stores the metadata of generated documents. The rendered
// bytes themselves live in the blob store, keyed by the hash recorded here.
type DocumentRepository struct {
	db *DB
}

// NewDocumentRepository returns a repository backed by db.
func NewDocumentRepository(db *DB) *DocumentRepository {
	return &DocumentRepository{db: db}
}

const documentColumns = "id, owner_id, template_id, template_version_id, template_version, " +
	"filename, blob_hash, size, data, created_at, batch_id"

// nullableID stores an optional identifier as a blob or as NULL.
func nullableID(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return idOf(*id)
}

// Create records a generated document.
func (r *DocumentRepository) Create(ctx context.Context, d *domain.Document) error {
	const query = `INSERT INTO documents (` + documentColumns + `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	data, err := json.Marshal(d.Data)
	if err != nil {
		return fmt.Errorf("sqlite: encode document data: %w", err)
	}

	_, err = r.db.write.ExecContext(ctx, query,
		idOf(d.ID), idOf(d.OwnerID), idOf(d.TemplateID), idOf(d.TemplateVersionID),
		d.TemplateVersion, d.Filename, d.BlobHash, d.Size, string(data),
		formatTime(d.CreatedAt), nullableID(d.BatchID),
	)
	if err != nil {
		return fmt.Errorf("sqlite: create document: %w", err)
	}
	return nil
}

// ByID returns one document owned by ownerID. Ownership is part of the query,
// so a caller cannot accidentally read another account's document.
func (r *DocumentRepository) ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.Document, error) {
	const query = `SELECT ` + documentColumns + ` FROM documents WHERE id = ? AND owner_id = ?`
	return scanDocumentRow(r.db.read.QueryRowContext(ctx, query, idOf(id), idOf(ownerID)))
}

// List returns a page of the documents owned by ownerID, newest first,
// optionally narrowed to a template or a batch. The ordering comes free from
// the identifier: UUIDv7 sorts by creation time.
func (r *DocumentRepository) List(ctx context.Context, ownerID uuid.UUID, filter domain.DocumentFilter, limit, offset int) ([]domain.Document, error) {
	// The clauses are fixed strings chosen by which filters are set; every
	// value travels as a bound parameter.
	query := `SELECT ` + documentColumns + ` FROM documents WHERE owner_id = ?`
	args := []any{idOf(ownerID)}
	if filter.TemplateID != nil {
		query += ` AND template_id = ?`
		args = append(args, idOf(*filter.TemplateID))
	}
	if filter.BatchID != nil {
		query += ` AND batch_id = ?`
		args = append(args, idOf(*filter.BatchID))
	}
	query += ` ORDER BY id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := r.db.read.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: list documents: %w", err)
	}
	defer rows.Close()

	var out []domain.Document
	for rows.Next() {
		d, err := scanDocumentRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list documents: %w", err)
	}
	return out, nil
}

func scanDocumentRow(row rowScanner) (*domain.Document, error) {
	var (
		d               domain.Document
		rawID           []byte
		rawOwnerID      []byte
		rawTemplateID   []byte
		rawVersionID    []byte
		rawBatchID      []byte
		data, createdAt string
	)

	err := row.Scan(
		&rawID, &rawOwnerID, &rawTemplateID, &rawVersionID, &d.TemplateVersion,
		&d.Filename, &d.BlobHash, &d.Size, &data, &createdAt, &rawBatchID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("document: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan document: %w", err)
	}

	for _, field := range []struct {
		raw []byte
		dst *uuid.UUID
	}{
		{rawID, &d.ID},
		{rawOwnerID, &d.OwnerID},
		{rawTemplateID, &d.TemplateID},
		{rawVersionID, &d.TemplateVersionID},
	} {
		if *field.dst, err = idFrom(field.raw); err != nil {
			return nil, err
		}
	}

	if rawBatchID != nil {
		batchID, err := idFrom(rawBatchID)
		if err != nil {
			return nil, err
		}
		d.BatchID = &batchID
	}

	if err = json.Unmarshal([]byte(data), &d.Data); err != nil {
		return nil, fmt.Errorf("sqlite: decode document data: %w", err)
	}
	if d.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse document created_at: %w", err)
	}
	return &d, nil
}

// Delete removes one generated document, reporting its blob hash when no other
// row refers to it any more.
//
// An empty hash means the file must stay: deduplication can leave it as the
// body of another document, possibly one belonging to a different account.
func (r *DocumentRepository) Delete(ctx context.Context, ownerID, id uuid.UUID) (string, error) {
	const read = `SELECT blob_hash FROM documents WHERE id = ? AND owner_id = ?`
	const remove = `DELETE FROM documents WHERE id = ? AND owner_id = ?`

	var orphaned string

	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var hash string
		err := tx.QueryRowContext(ctx, read, idOf(id), idOf(ownerID)).Scan(&hash)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("document: %w", domain.ErrNotFound)
		}
		if err != nil {
			return fmt.Errorf("sqlite: read document: %w", err)
		}

		if _, err := tx.ExecContext(ctx, remove, idOf(id), idOf(ownerID)); err != nil {
			return fmt.Errorf("sqlite: delete document: %w", err)
		}

		unreferenced, err := unreferencedHashes(ctx, tx, []string{hash})
		if err != nil {
			return err
		}
		if len(unreferenced) == 1 {
			orphaned = unreferenced[0]
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return orphaned, nil
}
