package sqlite

import (
	"context"
	"fmt"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// StatsRepository answers the aggregate questions behind a dashboard.
//
// Instants are compared as text, which is sound only because timeLayout is
// fixed-width UTC: "…T09:…" sorts after "…T08:…" exactly as the instants do.
type StatsRepository struct {
	db *DB
}

// NewStatsRepository returns a repository backed by db.
func NewStatsRepository(db *DB) *StatsRepository {
	return &StatsRepository{db: db}
}

// CountActiveTemplates counts the templates not deleted.
func (r *StatsRepository) CountActiveTemplates(ctx context.Context, ownerID uuid.UUID) (int, error) {
	const query = `SELECT COUNT(*) FROM templates WHERE owner_id = ? AND deleted_at IS NULL`
	var n int
	if err := r.db.read.QueryRowContext(ctx, query, idOf(ownerID)).Scan(&n); err != nil {
		return 0, fmt.Errorf("sqlite: count templates: %w", err)
	}
	return n, nil
}

// CountDocuments counts every document the account holds.
func (r *StatsRepository) CountDocuments(ctx context.Context, ownerID uuid.UUID) (int, error) {
	const query = `SELECT COUNT(*) FROM documents WHERE owner_id = ?`
	var n int
	if err := r.db.read.QueryRowContext(ctx, query, idOf(ownerID)).Scan(&n); err != nil {
		return 0, fmt.Errorf("sqlite: count documents: %w", err)
	}
	return n, nil
}

// DocumentTimesSince returns the creation instant of every document generated
// at or after since.
func (r *StatsRepository) DocumentTimesSince(ctx context.Context, ownerID uuid.UUID, since time.Time) ([]time.Time, error) {
	const query = `SELECT created_at FROM documents WHERE owner_id = ? AND created_at >= ?`

	rows, err := r.db.read.QueryContext(ctx, query, idOf(ownerID), formatTime(since))
	if err != nil {
		return nil, fmt.Errorf("sqlite: read document times: %w", err)
	}
	defer rows.Close()

	var out []time.Time
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("sqlite: scan document time: %w", err)
		}
		at, err := parseTime(raw)
		if err != nil {
			return nil, fmt.Errorf("sqlite: parse document time: %w", err)
		}
		out = append(out, at)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: read document times: %w", err)
	}
	return out, nil
}

// TopTemplatesSince ranks templates by the documents generated from them at or
// after since. Deleted templates are included and marked: their documents are
// still the account's, and still count.
func (r *StatsRepository) TopTemplatesSince(ctx context.Context, ownerID uuid.UUID, since time.Time, limit int) ([]domain.TemplateUsage, error) {
	const query = `SELECT d.template_id, t.name, t.deleted_at IS NOT NULL, COUNT(*) AS documents
		FROM documents d
		JOIN templates t ON t.id = d.template_id
		WHERE d.owner_id = ? AND d.created_at >= ?
		GROUP BY d.template_id, t.name, t.deleted_at
		ORDER BY documents DESC, t.name ASC
		LIMIT ?`

	rows, err := r.db.read.QueryContext(ctx, query, idOf(ownerID), formatTime(since), limit)
	if err != nil {
		return nil, fmt.Errorf("sqlite: rank templates: %w", err)
	}
	defer rows.Close()

	var out []domain.TemplateUsage
	for rows.Next() {
		var (
			u       domain.TemplateUsage
			rawID   []byte
			deleted int
		)
		if err := rows.Scan(&rawID, &u.Name, &deleted, &u.Documents); err != nil {
			return nil, fmt.Errorf("sqlite: scan template usage: %w", err)
		}
		if u.TemplateID, err = idFrom(rawID); err != nil {
			return nil, err
		}
		u.Deleted = deleted != 0
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: rank templates: %w", err)
	}
	return out, nil
}
