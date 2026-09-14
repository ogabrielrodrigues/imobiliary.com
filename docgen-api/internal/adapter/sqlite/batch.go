package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"uuid"

	"docgen/internal/domain"
)

// BatchRepository stores batches, and answers the history that mixes them with
// documents generated on their own.
type BatchRepository struct {
	db *DB
}

// NewBatchRepository returns a repository backed by db.
func NewBatchRepository(db *DB) *BatchRepository {
	return &BatchRepository{db: db}
}

const batchColumns = "b.id, b.owner_id, b.template_id, b.template_version_id, " +
	"b.template_version, b.name, b.created_at"

// batchSummary reads batches with the count and total size of their documents.
// The caller appends the WHERE clause.
const batchSummary = `SELECT ` + batchColumns + `,
		COUNT(d.id), COALESCE(SUM(d.size), 0)
	FROM batches b LEFT JOIN documents d ON d.batch_id = b.id`

// Create records a batch.
func (r *BatchRepository) Create(ctx context.Context, b *domain.Batch) error {
	const query = `INSERT INTO batches (id, owner_id, template_id, template_version_id,
		template_version, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.write.ExecContext(ctx, query,
		idOf(b.ID), idOf(b.OwnerID), idOf(b.TemplateID), idOf(b.TemplateVersionID),
		b.TemplateVersion, b.Name, formatTime(b.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("sqlite: create batch: %w", err)
	}
	return nil
}

// ByID returns one batch owned by ownerID, with what it holds.
func (r *BatchRepository) ByID(ctx context.Context, ownerID, id uuid.UUID) (*domain.BatchSummary, error) {
	query := batchSummary + ` WHERE b.id = ? AND b.owner_id = ? GROUP BY b.id`
	return scanBatchSummary(r.db.read.QueryRowContext(ctx, query, idOf(id), idOf(ownerID)))
}

// AllForOwner returns every batch of an account, oldest first.
func (r *BatchRepository) AllForOwner(ctx context.Context, ownerID uuid.UUID) ([]domain.Batch, error) {
	query := batchSummary + ` WHERE b.owner_id = ? GROUP BY b.id ORDER BY b.id`

	rows, err := r.db.read.QueryContext(ctx, query, idOf(ownerID))
	if err != nil {
		return nil, fmt.Errorf("sqlite: list batches: %w", err)
	}
	defer rows.Close()

	var out []domain.Batch
	for rows.Next() {
		s, err := scanBatchSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s.Batch)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: list batches: %w", err)
	}
	return out, nil
}

// Delete removes a batch and every document in it, reporting the blob hashes
// no surviving row refers to.
//
// The documents are deleted explicitly rather than left to the cascade, so the
// statement says what it does; the hashes are read first, because afterwards
// there is nothing left to read them from.
func (r *BatchRepository) Delete(ctx context.Context, ownerID, id uuid.UUID) ([]string, error) {
	const hashes = `SELECT DISTINCT blob_hash FROM documents WHERE batch_id = ? AND owner_id = ?`
	const removeDocuments = `DELETE FROM documents WHERE batch_id = ? AND owner_id = ?`
	const removeBatch = `DELETE FROM batches WHERE id = ? AND owner_id = ?`

	var orphaned []string

	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		batch, owner := idOf(id), idOf(ownerID)

		held, err := collectHashes(ctx, tx, hashes, batch, owner)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, removeDocuments, batch, owner); err != nil {
			return fmt.Errorf("sqlite: delete batch documents: %w", err)
		}

		result, err := tx.ExecContext(ctx, removeBatch, batch, owner)
		if err != nil {
			return fmt.Errorf("sqlite: delete batch: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("sqlite: delete batch: %w", err)
		}
		if affected == 0 {
			// Nothing was removed above either: no document of this owner can
			// name a batch that is not this owner's.
			return fmt.Errorf("batch: %w", domain.ErrNotFound)
		}

		orphaned, err = unreferencedHashes(ctx, tx, held)
		return err
	})
	if err != nil {
		return nil, err
	}
	return orphaned, nil
}

// History returns documents generated on their own and batches, mixed, newest
// first.
//
// The page is chosen over identifiers alone, which both tables share an order
// for: UUIDv7 sorts by creation time, and a batch is created before its
// documents. The rows of that page are then read in two queries, one per
// table, and put back in the page's order.
func (r *BatchRepository) History(ctx context.Context, ownerID uuid.UUID, templateID *uuid.UUID, limit, offset int) ([]domain.HistoryEntry, error) {
	documentsWhere := `owner_id = ? AND batch_id IS NULL`
	batchesWhere := `owner_id = ?`
	documentArgs := []any{idOf(ownerID)}
	batchArgs := []any{idOf(ownerID)}
	if templateID != nil {
		documentsWhere += ` AND template_id = ?`
		batchesWhere += ` AND template_id = ?`
		documentArgs = append(documentArgs, idOf(*templateID))
		batchArgs = append(batchArgs, idOf(*templateID))
	}

	page := `SELECT 'document', id FROM documents WHERE ` + documentsWhere + `
		UNION ALL
		SELECT 'batch', id FROM batches WHERE ` + batchesWhere + `
		ORDER BY 2 DESC LIMIT ? OFFSET ?`

	args := append(append(documentArgs, batchArgs...), limit, offset)
	rows, err := r.db.read.QueryContext(ctx, page, args...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: read history: %w", err)
	}

	type key struct {
		kind string
		id   uuid.UUID
	}
	var order []key
	var documentIDs, batchIDs []any
	for rows.Next() {
		var kind string
		var raw []byte
		if err := rows.Scan(&kind, &raw); err != nil {
			rows.Close()
			return nil, fmt.Errorf("sqlite: read history: %w", err)
		}
		id, err := idFrom(raw)
		if err != nil {
			rows.Close()
			return nil, err
		}
		order = append(order, key{kind, id})
		if kind == "document" {
			documentIDs = append(documentIDs, idOf(id))
		} else {
			batchIDs = append(batchIDs, idOf(id))
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("sqlite: read history: %w", err)
	}
	rows.Close()

	documents, err := r.documentsByID(ctx, documentIDs)
	if err != nil {
		return nil, err
	}
	batches, err := r.batchesByID(ctx, batchIDs)
	if err != nil {
		return nil, err
	}

	out := make([]domain.HistoryEntry, 0, len(order))
	for _, k := range order {
		if k.kind == "document" {
			if d, ok := documents[k.id]; ok {
				out = append(out, domain.HistoryEntry{Document: d})
			}
			continue
		}
		if b, ok := batches[k.id]; ok {
			out = append(out, domain.HistoryEntry{Batch: b})
		}
	}
	return out, nil
}

// placeholders returns "?, ?, ?" for n bound values.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

func (r *BatchRepository) documentsByID(ctx context.Context, ids []any) (map[uuid.UUID]*domain.Document, error) {
	out := make(map[uuid.UUID]*domain.Document, len(ids))
	if len(ids) == 0 {
		return out, nil
	}

	query := `SELECT ` + documentColumns + ` FROM documents WHERE id IN (` + placeholders(len(ids)) + `)`
	rows, err := r.db.read.QueryContext(ctx, query, ids...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: read history documents: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		d, err := scanDocumentRow(rows)
		if err != nil {
			return nil, err
		}
		out[d.ID] = d
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read history documents: %w", err)
	}
	return out, nil
}

func (r *BatchRepository) batchesByID(ctx context.Context, ids []any) (map[uuid.UUID]*domain.BatchSummary, error) {
	out := make(map[uuid.UUID]*domain.BatchSummary, len(ids))
	if len(ids) == 0 {
		return out, nil
	}

	query := batchSummary + ` WHERE b.id IN (` + placeholders(len(ids)) + `) GROUP BY b.id`
	rows, err := r.db.read.QueryContext(ctx, query, ids...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: read history batches: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		b, err := scanBatchSummary(rows)
		if err != nil {
			return nil, err
		}
		out[b.ID] = b
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read history batches: %w", err)
	}
	return out, nil
}

func scanBatchSummary(row rowScanner) (*domain.BatchSummary, error) {
	var (
		s                                              domain.BatchSummary
		rawID, rawOwnerID, rawTemplateID, rawVersionID []byte
		createdAt                                      string
	)

	err := row.Scan(
		&rawID, &rawOwnerID, &rawTemplateID, &rawVersionID, &s.TemplateVersion,
		&s.Name, &createdAt, &s.Documents, &s.Size,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("batch: %w", domain.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: scan batch: %w", err)
	}

	for _, field := range []struct {
		raw []byte
		dst *uuid.UUID
	}{
		{rawID, &s.ID},
		{rawOwnerID, &s.OwnerID},
		{rawTemplateID, &s.TemplateID},
		{rawVersionID, &s.TemplateVersionID},
	} {
		if *field.dst, err = idFrom(field.raw); err != nil {
			return nil, err
		}
	}

	if s.CreatedAt, err = parseTime(createdAt); err != nil {
		return nil, fmt.Errorf("sqlite: parse batch created_at: %w", err)
	}
	return &s, nil
}
