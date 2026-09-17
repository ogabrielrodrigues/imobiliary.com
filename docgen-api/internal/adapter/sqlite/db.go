// Package sqlite implements the repository interfaces declared by the use case
// layer on top of an embedded SQLite database.
package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"uuid"

	// modernc.org/sqlite is a pure-Go SQLite. It avoids cgo entirely, which is
	// what allows this service to ship as a single statically linked binary.
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// readPoolSize bounds concurrent readers. WAL lets them run alongside the
// single writer, so a small pool is enough to keep the CPU busy without
// holding many file handles open.
const readPoolSize = 8

// DB holds the two connection pools the service uses.
//
// SQLite serialises writers regardless of how many connections are opened
// against it, so the write pool is capped at a single connection. Queueing
// writers in the pool rather than letting them collide in the engine turns
// SQLITE_BUSY contention into ordinary waiting.
type DB struct {
	read  *sql.DB
	write *sql.DB
}

// Open prepares the database at path, creating it and applying any pending
// migrations.
func Open(ctx context.Context, path string) (*DB, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("sqlite: create database directory: %w", err)
		}
	}

	write, err := openPool(path, "immediate")
	if err != nil {
		return nil, err
	}
	// A single writer, held open: reconnecting would lose the pragmas.
	write.SetMaxOpenConns(1)
	write.SetMaxIdleConns(1)
	write.SetConnMaxLifetime(0)

	read, err := openPool(path, "deferred")
	if err != nil {
		write.Close()
		return nil, err
	}
	read.SetMaxOpenConns(readPoolSize)
	read.SetMaxIdleConns(readPoolSize)

	db := &DB{read: read, write: write}
	if err := db.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// openPool builds one pool with the pragmas this service depends on.
func openPool(path, txLock string) (*sql.DB, error) {
	// WAL lets readers proceed while a write is in flight, which is what makes
	// the split between the two pools worthwhile. synchronous=NORMAL is the
	// documented companion to WAL: durable across process crashes, trading only
	// the very last transactions in a power loss.
	dsn := fmt.Sprintf(
		"file:%s?_txlock=%s&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"+
			"&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)",
		url.PathEscape(path), txLock,
	)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	return db, nil
}

// Close releases both pools.
func (db *DB) Close() error {
	return errors.Join(db.read.Close(), db.write.Close())
}

// Ping verifies the database is reachable. It backs the health endpoint.
func (db *DB) Ping(ctx context.Context) error {
	return db.read.PingContext(ctx)
}

// migrate applies every embedded migration whose number is above the schema
// version recorded in the database, in one transaction per migration.
func (db *DB) migrate(ctx context.Context) error {
	entries, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("sqlite: list migrations: %w", err)
	}
	sort.Strings(entries)

	var current int
	if err := db.write.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("sqlite: read schema version: %w", err)
	}

	for i, name := range entries {
		version := i + 1
		if version <= current {
			continue
		}

		statements, err := migrationFS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("sqlite: read migration %s: %w", name, err)
		}

		// A migration that rebuilds tables says so on its first line. Foreign
		// keys must be off for that (a pragma ignored inside a transaction, so
		// set before it on the single writer connection), and every key is
		// checked again before the commit.
		rebuilds := strings.HasPrefix(string(statements), "-- docgen: rebuilds tables")
		if rebuilds {
			if _, err := db.write.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
				return fmt.Errorf("sqlite: turn foreign keys off for %s: %w", name, err)
			}
		}

		tx, err := db.write.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("sqlite: begin migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(statements)); err != nil {
			tx.Rollback()
			return fmt.Errorf("sqlite: apply migration %s: %w", name, err)
		}
		if rebuilds {
			rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
			if err != nil {
				tx.Rollback()
				return fmt.Errorf("sqlite: check foreign keys after %s: %w", name, err)
			}
			broken := rows.Next()
			rows.Close()
			if broken {
				tx.Rollback()
				return fmt.Errorf("sqlite: migration %s leaves a broken foreign key", name)
			}
		}
		// PRAGMA does not accept a bound parameter, and version is derived from
		// the embedded file list rather than from any input.
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			tx.Rollback()
			return fmt.Errorf("sqlite: record schema version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("sqlite: commit migration %s: %w", name, err)
		}
		if rebuilds {
			if _, err := db.write.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
				return fmt.Errorf("sqlite: turn foreign keys back on after %s: %w", name, err)
			}
		}
	}
	return nil
}

// withTx runs fn inside a write transaction, rolling back on error.
func (db *DB) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.write.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin transaction: %w", err)
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: commit transaction: %w", err)
	}
	return nil
}

// timeLayout is the stored representation of an instant: UTC, RFC 3339 with
// nanoseconds, which sorts correctly as text.
const timeLayout = "2006-01-02T15:04:05.000000000Z07:00"

func formatTime(t time.Time) string {
	return t.UTC().Format(timeLayout)
}

func parseTime(s string) (time.Time, error) {
	return time.Parse(timeLayout, s)
}

// formatNullTime encodes an optional instant for a nullable column.
func formatNullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return formatTime(*t)
}

func parseNullTime(s sql.NullString) (*time.Time, error) {
	if !s.Valid {
		return nil, nil
	}
	t, err := parseTime(s.String)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// idOf converts a UUID to its stored form.
func idOf(id uuid.UUID) []byte {
	return id[:]
}

// idFrom rebuilds a UUID from a stored blob.
func idFrom(b []byte) (uuid.UUID, error) {
	var id uuid.UUID
	if len(b) != len(id) {
		return id, fmt.Errorf("sqlite: identifier is %d bytes, want %d", len(b), len(id))
	}
	copy(id[:], b)
	return id, nil
}

// nullID encodes an optional identifier for a nullable column.
func nullID(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return idOf(*id)
}

// isUniqueViolation reports whether err is SQLite's uniqueness constraint
// failure. The driver does not export a typed error for it, so the message is
// matched instead.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
