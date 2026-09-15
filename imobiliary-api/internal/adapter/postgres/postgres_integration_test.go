//go:build integration

package postgres_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"uuid"

	"github.com/jackc/pgx/v5"

	"imobiliary/internal/adapter/postgres"
	"imobiliary/internal/platform/pgtest"
)

func withParam(url, param string) string {
	if strings.Contains(url, "?") {
		return url + "&" + param
	}
	return url + "?" + param
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func open(t *testing.T, url string) *postgres.DB {
	t.Helper()
	db, err := postgres.Open(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}

func TestMigrateAppliesEverythingOnceAndIsIdempotent(t *testing.T) {
	url := pgtest.NewEmptyDatabase(t)
	embedded, err := postgres.Migrations()
	if err != nil {
		t.Fatal(err)
	}

	applied, err := postgres.Migrate(t.Context(), url, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != len(embedded) {
		t.Fatalf("applied %d migrations, want %d", len(applied), len(embedded))
	}
	again, err := postgres.Migrate(t.Context(), url, quiet())
	if err != nil || len(again) != 0 {
		t.Fatalf("second run applied %d migrations, %v; want none", len(again), err)
	}
}

func TestConcurrentMigrationsDoNotCollide(t *testing.T) {
	url := pgtest.NewEmptyDatabase(t)

	const runs = 4
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		total int
		errs  []error
	)
	for range runs {
		wg.Go(func() {
			applied, err := postgres.Migrate(context.Background(), url, quiet())
			mu.Lock()
			defer mu.Unlock()
			total += len(applied)
			if err != nil {
				errs = append(errs, err)
			}
		})
	}
	wg.Wait()

	embedded, _ := postgres.Migrations()
	if len(errs) > 0 {
		t.Fatalf("concurrent runs failed: %v", errs)
	}
	if total != len(embedded) {
		t.Fatalf("%d concurrent runs applied %d migrations in total, want exactly %d", runs, total, len(embedded))
	}
}

func TestSchemaVersionIsEnforced(t *testing.T) {
	url := pgtest.NewEmptyDatabase(t)
	db := open(t, url)

	if err := db.RequireCurrentSchema(t.Context()); !errors.Is(err, postgres.ErrSchemaBehind) {
		t.Fatalf("empty database: RequireCurrentSchema = %v, want ErrSchemaBehind", err)
	}
	if _, err := postgres.Migrate(t.Context(), url, quiet()); err != nil {
		t.Fatal(err)
	}
	if err := db.RequireCurrentSchema(t.Context()); err != nil {
		t.Fatalf("migrated database: RequireCurrentSchema = %v", err)
	}

	conn, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(t.Context(), "INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, 'from_the_future', '\\x00')"); err != nil {
		t.Fatal(err)
	}
	if err := db.RequireCurrentSchema(t.Context()); !errors.Is(err, postgres.ErrSchemaAhead) {
		t.Fatalf("newer database: RequireCurrentSchema = %v, want ErrSchemaAhead", err)
	}
	if _, err := conn.Exec(t.Context(), "DELETE FROM schema_migrations WHERE version = 9999"); err != nil {
		t.Fatal(err)
	}

	// An applied migration edited after the fact is refused by both the
	// migrator and the service.
	if _, err := conn.Exec(t.Context(), "UPDATE schema_migrations SET checksum = '\\x00' WHERE version = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.Migrate(t.Context(), url, quiet()); !errors.Is(err, postgres.ErrMigrationChanged) {
		t.Fatalf("Migrate over a changed migration = %v, want ErrMigrationChanged", err)
	}
	if err := db.RequireCurrentSchema(t.Context()); !errors.Is(err, postgres.ErrMigrationChanged) {
		t.Fatalf("RequireCurrentSchema over a changed migration = %v, want ErrMigrationChanged", err)
	}
}

func TestInOrganizationScopesTheSettingToTheTransaction(t *testing.T) {
	db := open(t, pgtest.NewDatabase(t))
	org := uuid.NewV7()

	err := db.InOrganization(t.Context(), org, func(tx pgx.Tx) error {
		var got string
		if err := tx.QueryRow(t.Context(), "SELECT current_setting('app.organization_id', true)").Scan(&got); err != nil {
			return err
		}
		if got != org.String() {
			t.Errorf("inside the transaction the organisation is %q, want %q", got, org)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// set_config(..., true) is transaction-local by PostgreSQL's definition,
	// so what is worth checking is that this function uses that form: with the
	// pool held to one connection, the next transaction's organisation must be
	// its own and a plain query on that connection must see none.
	single := open(t, withParam(pgtest.NewDatabase(t), "pool_max_conns=1"))
	if err := single.InOrganization(t.Context(), org, func(pgx.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := single.RequireCurrentSchema(t.Context()); err != nil {
		t.Fatal(err)
	}
	var leaked *string
	if err := single.QueryRowForTest(t.Context(), "SELECT nullif(current_setting('app.organization_id', true), '')").Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != nil {
		t.Fatalf("the organisation %q outlived its transaction", *leaked)
	}

	rollback := errors.New("stop")
	if err := db.InOrganization(t.Context(), org, func(pgx.Tx) error { return rollback }); !errors.Is(err, rollback) {
		t.Fatalf("InOrganization did not return the callback's error: %v", err)
	}
	if err := db.InOrganization(t.Context(), uuid.Nil(), func(pgx.Tx) error { return nil }); err == nil {
		t.Fatal("InOrganization accepted the nil organisation")
	}
}

func TestSearchHelperIsAvailable(t *testing.T) {
	db := open(t, pgtest.NewDatabase(t))
	err := db.InOrganization(t.Context(), uuid.NewV7(), func(tx pgx.Tx) error {
		var got string
		if err := tx.QueryRow(t.Context(), "SELECT immutable_unaccent('João Conceição')").Scan(&got); err != nil {
			return err
		}
		if got != "Joao Conceicao" {
			t.Errorf("immutable_unaccent = %q", got)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
