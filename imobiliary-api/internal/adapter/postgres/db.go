// Package postgres implements the repository interfaces declared by the use
// case layer on top of PostgreSQL, through pgx.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB is the connection pool the service runs its queries through. It connects
// as the application role, which owns no table and cannot alter the schema.
type DB struct {
	pool *pgxpool.Pool
}

// Open connects to the database and verifies it is reachable.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("postgres: parse database url: %w", err)
	}
	params := cfg.ConnConfig.RuntimeParams
	params["application_name"] = "imobiliary-api"
	// Instants are computed and formatted in Go. Pinning the session zone to
	// UTC keeps anything the database renders itself, such as a timestamptz in
	// a log line or a psql session opened through the same URL, from depending
	// on the server's configuration.
	params["timezone"] = "UTC"

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("postgres: create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}
	return &DB{pool: pool}, nil
}

// Close releases every connection.
func (db *DB) Close() { db.pool.Close() }

// Ping verifies the database is reachable. It backs the readiness endpoint.
func (db *DB) Ping(ctx context.Context) error { return db.pool.Ping(ctx) }

// RequireCurrentSchema returns nil only when every embedded migration, and no
// other, has been applied.
func (db *DB) RequireCurrentSchema(ctx context.Context) error {
	embedded, err := Migrations()
	if err != nil {
		return err
	}
	var exists bool
	if err := db.pool.QueryRow(ctx, "SELECT to_regclass('schema_migrations') IS NOT NULL").Scan(&exists); err != nil {
		return fmt.Errorf("postgres: look for schema_migrations: %w", err)
	}
	if !exists {
		return fmt.Errorf("%w: no migration has been applied", ErrSchemaBehind)
	}
	applied, err := appliedMigrations(ctx, db.pool)
	if err != nil {
		return err
	}
	return compare(embedded, applied)
}

// InOrganization runs fn in a transaction scoped to one organisation.
//
// The organisation is set with set_config(..., true), which lasts only until
// the transaction ends, so a pooled connection never carries one request's
// organisation into the next. Row-level security policies read it back with
// current_setting('app.organization_id', true); outside this function that
// setting is empty and those policies match no row.
func (db *DB) InOrganization(ctx context.Context, organizationID uuid.UUID, fn func(pgx.Tx) error) error {
	if organizationID == uuid.Nil() {
		return errors.New("postgres: organisation-scoped transaction without an organisation")
	}
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin transaction: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if _, err := tx.Exec(ctx, "SELECT set_config('app.organization_id', $1, true)", organizationID.String()); err != nil {
		return fmt.Errorf("postgres: scope transaction to organisation: %w", err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit transaction: %w", err)
	}
	return nil
}

// QueryRowForTest and QueryForTest run a query outside any organisation scope.
// They exist for the integration tests, which live in another package to avoid
// an import cycle with pgtest, and must not be used by repositories.
func (db *DB) QueryRowForTest(ctx context.Context, sql string, args ...any) pgx.Row {
	return db.pool.QueryRow(ctx, sql, args...)
}

func (db *DB) QueryForTest(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return db.pool.Query(ctx, sql, args...)
}
