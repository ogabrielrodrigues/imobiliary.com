//go:build integration

// Package pgtest gives each integration test a PostgreSQL database of its own.
//
// Migrating a fresh database for every test would be slow, and sharing one
// would let tests see each other's rows. Instead the migrated schema is built
// once into a template database, and each test gets a copy made with
// CREATE DATABASE ... TEMPLATE, which is a file copy and takes milliseconds.
//
// The template's name carries a digest of the embedded migrations, so a
// changed migration builds a new template rather than reusing a stale one.
// Packages run their tests in separate processes at the same time; an advisory
// lock keeps two of them from building the same template at once.
//
// It needs IMOBILIARY_TEST_DATABASE_URL: a maintenance database (usually
// "postgres") reached as a role with CREATEDB. scripts/setup-local.sql creates
// that role and the imobiliary_app role the migrations grant to.
package pgtest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"uuid"

	"github.com/jackc/pgx/v5"

	"imobiliary/internal/adapter/postgres"
	"imobiliary/internal/platform/config"
)

// templateLockKey serialises template builds across test processes. It spells
// "tmpl".
const templateLockKey int64 = 0x746d706c

var (
	templateOnce sync.Once
	templateName string
	templateErr  error
)

// NewDatabase returns the URL of a fresh, fully migrated database, dropped when
// the test ends.
func NewDatabase(t testing.TB) string {
	t.Helper()
	admin := adminURL(t)
	templateOnce.Do(func() { templateName, templateErr = buildTemplate(admin) })
	if templateErr != nil {
		t.Fatalf("pgtest: build template database: %v", templateErr)
	}
	return createDatabase(t, admin, templateName)
}

// NewEmptyDatabase returns the URL of a database with no migration applied,
// for tests of the migrations themselves.
func NewEmptyDatabase(t testing.TB) string {
	t.Helper()
	return createDatabase(t, adminURL(t), "template0")
}

var loadEnvOnce sync.Once

func adminURL(t testing.TB) string {
	t.Helper()
	// A test binary runs in its package directory and inherits no .env, so the
	// module's own file is read once, the same way the commands do. Anything
	// already in the environment still wins.
	loadEnvOnce.Do(func() {
		if root, err := moduleRoot(); err == nil {
			_ = config.LoadDotEnv(filepath.Join(root, ".env"))
		}
	})
	u := os.Getenv("IMOBILIARY_TEST_DATABASE_URL")
	if u == "" {
		t.Fatal("pgtest: IMOBILIARY_TEST_DATABASE_URL is not set, and imobiliary-api/.env does not set it; see imobiliary-api/README.md")
	}
	return u
}

// moduleRoot walks up from the working directory to the directory holding
// go.mod.
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("pgtest: no go.mod above %s", dir)
		}
		dir = parent
	}
}

func createDatabase(t testing.TB, admin, template string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	name := "imobiliary_test_" + strings.ReplaceAll(uuid.NewV4().String(), "-", "")
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatalf("pgtest: connect: %v", err)
	}
	defer conn.Close(context.Background())

	// Identifiers cannot be bound as parameters; both names are built here
	// from a UUID and a digest, never from input.
	if _, err := conn.Exec(ctx, fmt.Sprintf("CREATE DATABASE %s TEMPLATE %s", name, template)); err != nil {
		t.Fatalf("pgtest: create database: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, admin)
		if err != nil {
			t.Errorf("pgtest: connect to drop %s: %v", name, err)
			return
		}
		defer conn.Close(context.Background())
		// FORCE terminates the test's own connections, but not a process
		// another role runs in that database, such as an autovacuum worker
		// that started after the test's writes. That process ends by itself
		// within moments, so the drop is tried again for a few seconds
		// before it counts as a failure; once it failed a passing test.
		var dropErr error
		for attempt := 0; attempt < 20; attempt++ {
			if _, dropErr = conn.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", name)); dropErr == nil {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Errorf("pgtest: drop %s: %v", name, dropErr)
	})
	return withDatabase(t, admin, name)
}

func buildTemplate(admin string) (string, error) {
	migrations, err := postgres.Migrations()
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	for _, m := range migrations {
		digest.Write(m.Checksum[:])
	}
	name := "imobiliary_template_" + hex.EncodeToString(digest.Sum(nil))[:16]

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return "", fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", templateLockKey); err != nil {
		return "", fmt.Errorf("take template lock: %w", err)
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", templateLockKey)

	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil {
		return "", fmt.Errorf("look for template: %w", err)
	}
	if exists {
		return name, nil
	}

	var appRole bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'imobiliary_app')").Scan(&appRole); err != nil {
		return "", fmt.Errorf("look for imobiliary_app: %w", err)
	}
	if !appRole {
		return "", fmt.Errorf("role imobiliary_app does not exist; run scripts/setup-local.sql")
	}

	// Built under a temporary name and renamed when complete, so a build that
	// dies half way never leaves a template that looks finished.
	building := name + "_building"
	if _, err := conn.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", building)); err != nil {
		return "", fmt.Errorf("drop stale build: %w", err)
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("CREATE DATABASE %s TEMPLATE template0", building)); err != nil {
		return "", fmt.Errorf("create template: %w", err)
	}
	buildURL, err := replaceDatabase(admin, building)
	if err != nil {
		return "", err
	}
	if _, err := postgres.Migrate(ctx, buildURL, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		return "", fmt.Errorf("migrate template: %w", err)
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", building, name)); err != nil {
		return "", fmt.Errorf("finish template: %w", err)
	}
	return name, nil
}

func withDatabase(t testing.TB, admin, name string) string {
	t.Helper()
	u, err := replaceDatabase(admin, name)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// replaceDatabase points a postgres:// URL at another database.
func replaceDatabase(raw, name string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", fmt.Errorf("pgtest: IMOBILIARY_TEST_DATABASE_URL must be a postgres:// URL")
	}
	u.Path = "/" + name
	return u.String(), nil
}
