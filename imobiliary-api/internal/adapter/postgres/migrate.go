package postgres

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrationLockKey identifies the advisory lock migrations hold. Two instances
// starting together would otherwise both find the same migration pending and
// both try to apply it; with the lock the second waits, then finds nothing to
// do. The value spells "imob" and only has to differ from any other advisory
// lock taken on the same database.
const migrationLockKey int64 = 0x696d6f62

// Errors reported when the database and the binary disagree about the schema.
var (
	// ErrMigrationChanged means a migration already applied no longer matches
	// the file embedded in this binary. Applied migrations are history: fixing
	// one means writing the next.
	ErrMigrationChanged = errors.New("postgres: an applied migration was modified")
	// ErrSchemaAhead means the database holds a migration this binary does not
	// know, which is what running an older build against a newer schema looks
	// like.
	ErrSchemaAhead = errors.New("postgres: database schema is newer than this build")
	// ErrSchemaBehind means migrations are pending. The service refuses to
	// serve rather than run queries against a schema it was not written for.
	ErrSchemaBehind = errors.New("postgres: database schema has pending migrations; run the migrate command")
)

// Migration is one embedded schema change.
type Migration struct {
	Version  int
	Name     string
	SQL      string
	Checksum [sha256.Size]byte
}

// Migrations returns the embedded migrations in order. File names are
// NNNN_description.sql, numbered from 1 with no gaps, so a missing or
// duplicated file is caught here rather than by a half-applied schema.
func Migrations() ([]Migration, error) {
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("postgres: list migrations: %w", err)
	}
	slices.Sort(names)

	out := make([]Migration, 0, len(names))
	for i, name := range names {
		base := strings.TrimSuffix(path.Base(name), ".sql")
		rawVersion, _, found := strings.Cut(base, "_")
		version, err := strconv.Atoi(rawVersion)
		if !found || err != nil {
			return nil, fmt.Errorf("postgres: migration %s is not named NNNN_description.sql", name)
		}
		if version != i+1 {
			return nil, fmt.Errorf("postgres: migration %s should be number %d", name, i+1)
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return nil, fmt.Errorf("postgres: read migration %s: %w", name, err)
		}
		out = append(out, Migration{
			Version:  version,
			Name:     base,
			SQL:      string(body),
			Checksum: sha256.Sum256(body),
		})
	}
	return out, nil
}

// createMigrationsTable is run before any migration, so the first one can
// already grant on it.
const createMigrationsTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version    integer     PRIMARY KEY,
	name       text        NOT NULL,
	checksum   bytea       NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now()
)`

// Migrate applies every pending migration, each in its own transaction, while
// holding the migration lock. It connects with url, which must be the role
// that owns the schema, and returns the migrations it applied.
func Migrate(ctx context.Context, url string, logger *slog.Logger) ([]Migration, error) {
	migrations, err := Migrations()
	if err != nil {
		return nil, err
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("postgres: connect for migrations: %w", err)
	}
	defer conn.Close(context.WithoutCancel(ctx))

	// A session-level lock: it outlives the per-migration transactions and is
	// released when this connection closes, even if the process dies.
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		return nil, fmt.Errorf("postgres: take migration lock: %w", err)
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", migrationLockKey)

	if _, err := conn.Exec(ctx, createMigrationsTable); err != nil {
		return nil, fmt.Errorf("postgres: create schema_migrations: %w", err)
	}

	applied, err := appliedMigrations(ctx, conn)
	if err != nil {
		return nil, err
	}
	if err := compare(migrations, applied); err != nil && !errors.Is(err, ErrSchemaBehind) {
		return nil, err
	}

	var done []Migration
	for _, m := range migrations[len(applied):] {
		if err := apply(ctx, conn, m); err != nil {
			return done, err
		}
		logger.Info("migration applied", slog.Int("version", m.Version), slog.String("name", m.Name))
		done = append(done, m)
	}
	return done, nil
}

func apply(ctx context.Context, conn *pgx.Conn, m Migration) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin migration %s: %w", m.Name, err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	// With no arguments pgx uses the simple query protocol, which accepts a
	// file holding several statements.
	if _, err := tx.Exec(ctx, m.SQL); err != nil {
		return fmt.Errorf("postgres: apply migration %s: %w", m.Name, err)
	}
	if _, err := tx.Exec(ctx,
		"INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
		m.Version, m.Name, m.Checksum[:],
	); err != nil {
		return fmt.Errorf("postgres: record migration %s: %w", m.Name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit migration %s: %w", m.Name, err)
	}
	return nil
}

type appliedMigration struct {
	version  int
	checksum []byte
}

// rowsQuerier is the little the migration history needs, which both a
// connection and the pool provide.
type rowsQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func appliedMigrations(ctx context.Context, q rowsQuerier) ([]appliedMigration, error) {
	rows, err := q.Query(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return nil, fmt.Errorf("postgres: read schema_migrations: %w", err)
	}
	applied, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (appliedMigration, error) {
		var a appliedMigration
		err := row.Scan(&a.version, &a.checksum)
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("postgres: read schema_migrations: %w", err)
	}
	return applied, nil
}

// compare checks the applied history against the embedded migrations. It
// returns nil when they match exactly, ErrSchemaBehind when the history is a
// proper prefix, and another error when they have diverged.
func compare(embedded []Migration, applied []appliedMigration) error {
	for i, a := range applied {
		if i >= len(embedded) || a.version != embedded[i].Version {
			return fmt.Errorf("%w: version %d is applied but not embedded", ErrSchemaAhead, a.version)
		}
		if string(a.checksum) != string(embedded[i].Checksum[:]) {
			return fmt.Errorf("%w: %s", ErrMigrationChanged, embedded[i].Name)
		}
	}
	if len(applied) < len(embedded) {
		return fmt.Errorf("%w: %d of %d applied", ErrSchemaBehind, len(applied), len(embedded))
	}
	return nil
}
