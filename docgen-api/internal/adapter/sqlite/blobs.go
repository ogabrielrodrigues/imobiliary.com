package sqlite

import (
	"context"
	"database/sql"
	"fmt"
)

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
