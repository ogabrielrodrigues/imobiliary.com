//go:build integration

package sqlite

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// openTestDB opens a throwaway database on disk. A file is used rather than
// SQLite's in-memory mode because the service depends on WAL, which only
// applies to a real file.
func openTestDB(t *testing.T) *DB {
	t.Helper()

	db, err := Open(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func newTestUser(t *testing.T, ctx context.Context, db *DB) *domain.Owner {
	t.Helper()

	id := uuid.NewV7()
	if err := NewOwnerRepository(db).EnsureOrganization(ctx, id, "Escritório "+id.String()[:8], time.Now()); err != nil {
		t.Fatalf("create owner: %v", err)
	}
	return &domain.Owner{ID: id}
}

func TestMigrationsAreIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	first, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	first.Close()

	second, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("reopening an already migrated database: %v", err)
	}
	second.Close()
}

// A legacy account keeps its rows until an office claims it by e-mail, once.
func TestClaimLegacyMovesEverythingOnce(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	owners := NewOwnerRepository(db)
	now := time.Now().UTC()

	legacy := uuid.NewV7()
	if _, err := db.write.ExecContext(ctx,
		`INSERT INTO owners (id, kind, name, email, created_at) VALUES (?, 'legacy_account', 'Ada', 'ada@example.com', ?)`,
		idOf(legacy), formatTime(now)); err != nil {
		t.Fatal(err)
	}
	templates := NewTemplateRepository(db)
	template := &domain.Template{ID: uuid.NewV7(), OwnerID: legacy, Name: "Contrato", CreatedAt: now, UpdatedAt: now, LatestVersion: 1}
	version := &domain.TemplateVersion{ID: uuid.NewV7(), TemplateID: template.ID, Version: 1, BlobHash: "h", Size: 1, CreatedAt: now}
	if err := templates.Create(ctx, template, version); err != nil {
		t.Fatal(err)
	}

	office := newTestUser(t, ctx, db)
	other := newTestUser(t, ctx, db)
	moved, err := owners.ClaimLegacy(ctx, " ADA@example.com ", office.ID, now)
	if err != nil || !moved {
		t.Fatalf("claim = %v, %v", moved, err)
	}
	if _, err := templates.ByID(ctx, office.ID, template.ID); err != nil {
		t.Errorf("the office does not own the template: %v", err)
	}
	if moved, _ := owners.ClaimLegacy(ctx, "ada@example.com", other.ID, now); moved {
		t.Error("the same account moved twice")
	}
	if moved, _ := owners.ClaimLegacy(ctx, "nobody@example.com", other.ID, now); moved {
		t.Error("an unknown e-mail moved something")
	}
	stored, err := owners.ByID(ctx, legacy)
	if err != nil || stored.MergedInto == nil || *stored.MergedInto != office.ID || stored.Kind != domain.OwnerLegacyAccount {
		t.Errorf("legacy owner %+v, %v", stored, err)
	}
}

func TestTemplateVersioning(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	templates := NewTemplateRepository(db)
	user := newTestUser(t, ctx, db)
	now := time.Now().UTC()

	tmpl := &domain.Template{
		ID:            uuid.NewV7(),
		OwnerID:       user.ID,
		Name:          "Service agreement",
		Description:   "Standard contract",
		LatestVersion: 1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	first := &domain.TemplateVersion{
		ID:           uuid.NewV7(),
		TemplateID:   tmpl.ID,
		Version:      1,
		BlobHash:     "aa11",
		Size:         1024,
		Placeholders: []string{"customer_name", "amount"},
		CreatedAt:    now,
	}
	if err := templates.Create(ctx, tmpl, first); err != nil {
		t.Fatalf("create template: %v", err)
	}

	got, err := templates.ByID(ctx, user.ID, tmpl.ID)
	if err != nil {
		t.Fatalf("ByID: %v", err)
	}
	if got.LatestVersion != 1 || got.Name != tmpl.Name {
		t.Errorf("ByID returned %+v", got)
	}

	// A second version must be numbered automatically and become the latest.
	second := &domain.TemplateVersion{
		ID:           uuid.NewV7(),
		TemplateID:   tmpl.ID,
		BlobHash:     "bb22",
		Size:         2048,
		Placeholders: []string{"customer_name"},
		CreatedAt:    now.Add(time.Minute),
	}
	if err := templates.AddVersion(ctx, user.ID, second); err != nil {
		t.Fatalf("AddVersion: %v", err)
	}
	if second.Version != 2 {
		t.Errorf("AddVersion assigned version %d, want 2", second.Version)
	}

	latest, err := templates.LatestVersion(ctx, user.ID, tmpl.ID)
	if err != nil {
		t.Fatalf("LatestVersion: %v", err)
	}
	if latest.Version != 2 || latest.BlobHash != "bb22" {
		t.Errorf("LatestVersion = %+v, want version 2", latest)
	}

	// The earlier version stays readable, which is what makes an existing
	// document reproducible after the template moves on.
	old, err := templates.Version(ctx, user.ID, tmpl.ID, 1)
	if err != nil {
		t.Fatalf("Version(1): %v", err)
	}
	if !slices.Equal(old.Placeholders, []string{"customer_name", "amount"}) {
		t.Errorf("version 1 placeholders = %v", old.Placeholders)
	}

	// Listing reports both versions newest first, which is the order a client
	// offers them in.
	all, err := templates.Versions(ctx, user.ID, tmpl.ID, 20, 0)
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	if len(all) != 2 || all[0].Version != 2 || all[1].Version != 1 {
		t.Fatalf("Versions returned %d entries, want 2 ordered 2 then 1", len(all))
	}
	if !slices.Equal(all[1].Placeholders, []string{"customer_name", "amount"}) {
		t.Errorf("listed version 1 placeholders = %v", all[1].Placeholders)
	}

	// Paging is wired rather than decorative: the second page holds version 1.
	page, err := templates.Versions(ctx, user.ID, tmpl.ID, 1, 1)
	if err != nil {
		t.Fatalf("Versions(limit 1, offset 1): %v", err)
	}
	if len(page) != 1 || page[0].Version != 1 {
		t.Errorf("second page = %+v, want only version 1", page)
	}

	// Another account must not see this template at all.
	stranger := newTestUser(t, ctx, db)
	if _, err := templates.ByID(ctx, stranger.ID, tmpl.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("a stranger could read the template: %v", err)
	}
	if versions, err := templates.Versions(ctx, stranger.ID, tmpl.ID, 20, 0); err != nil || len(versions) != 0 {
		t.Errorf("a stranger listed %d versions (err %v), want none", len(versions), err)
	}

	if err := templates.SoftDelete(ctx, user.ID, tmpl.ID, now); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	if _, err := templates.ByID(ctx, user.ID, tmpl.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("template is still visible after deletion: %v", err)
	}
	// The versions go with it. They still exist for the documents that refer to
	// them, but they are no longer reachable through the template.
	if versions, err := templates.Versions(ctx, user.ID, tmpl.ID, 20, 0); err != nil || len(versions) != 0 {
		t.Errorf("deleted template listed %d versions (err %v), want none", len(versions), err)
	}
}

func TestDocumentRepositoryIsolatesOwners(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	templates := NewTemplateRepository(db)
	documents := NewDocumentRepository(db)
	user := newTestUser(t, ctx, db)
	stranger := newTestUser(t, ctx, db)
	now := time.Now().UTC()

	tmpl := &domain.Template{
		ID: uuid.NewV7(), OwnerID: user.ID, Name: "Invoice",
		LatestVersion: 1, CreatedAt: now, UpdatedAt: now,
	}
	version := &domain.TemplateVersion{
		ID: uuid.NewV7(), TemplateID: tmpl.ID, Version: 1,
		BlobHash: "cc33", Size: 512, Placeholders: []string{"amount"}, CreatedAt: now,
	}
	if err := templates.Create(ctx, tmpl, version); err != nil {
		t.Fatalf("create template: %v", err)
	}

	doc := &domain.Document{
		ID:                uuid.NewV7(),
		OwnerID:           user.ID,
		TemplateID:        tmpl.ID,
		TemplateVersionID: version.ID,
		TemplateVersion:   1,
		Filename:          "invoice.docx",
		BlobHash:          "dd44",
		Size:              4096,
		Data:              map[string]string{"amount": "R$ 1.000,00"},
		CreatedAt:         now,
	}
	if err := documents.Create(ctx, doc); err != nil {
		t.Fatalf("create document: %v", err)
	}

	got, err := documents.ByID(ctx, user.ID, doc.ID)
	if err != nil {
		t.Fatalf("ByID: %v", err)
	}
	if got.Data["amount"] != "R$ 1.000,00" {
		t.Errorf("document data round-tripped as %v", got.Data)
	}

	if _, err := documents.ByID(ctx, stranger.ID, doc.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("a stranger could read the document: %v", err)
	}

	list, err := documents.List(ctx, stranger.ID, domain.DocumentFilter{}, 10, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("stranger's listing returned %d documents, want 0", len(list))
	}
}

// A database from before identity moved keeps its rows: accounts become legacy
// owners, and templates and documents still point at them.
func TestOrganizationsMigrationKeepsExistingRows(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "old.db")

	old, err := openPool(path, "immediate")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 4; i++ {
		names, _ := fs.Glob(migrationFS, "migrations/000"+strconv.Itoa(i)+"_*.sql")
		sqlText, err := migrationFS.ReadFile(names[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := old.ExecContext(ctx, string(sqlText)); err != nil {
			t.Fatalf("migration %d: %v", i, err)
		}
	}
	now := formatTime(time.Now())
	user, template, version, document := idOf(uuid.NewV7()), idOf(uuid.NewV7()), idOf(uuid.NewV7()), idOf(uuid.NewV7())
	for _, stmt := range []struct {
		q    string
		args []any
	}{
		{`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, 'ada@example.com', 'Ada', 'x', ?, ?)`, []any{user, now, now}},
		{`INSERT INTO templates (id, owner_id, name, description, latest_version, created_at, updated_at) VALUES (?, ?, 'Contrato', '', 1, ?, ?)`, []any{template, user, now, now}},
		{`INSERT INTO template_versions (id, template_id, version, blob_hash, size, placeholders, created_at) VALUES (?, ?, 1, 'h', 1, '[]', ?)`, []any{version, template, now}},
		{`INSERT INTO documents (id, owner_id, template_id, template_version_id, template_version, filename, blob_hash, size, data, created_at) VALUES (?, ?, ?, ?, 1, 'a.docx', 'h', 1, '{}', ?)`, []any{document, user, template, version, now}},
		{`PRAGMA user_version = 4`, nil},
	} {
		if _, err := old.ExecContext(ctx, stmt.q, stmt.args...); err != nil {
			t.Fatalf("%s: %v", stmt.q, err)
		}
	}
	old.Close()

	db, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("migrating an old database: %v", err)
	}
	defer db.Close()
	owner, err := NewOwnerRepository(db).ByID(ctx, uuid.UUID(user))
	if err != nil || owner.Kind != domain.OwnerLegacyAccount || owner.Email != "ada@example.com" {
		t.Fatalf("legacy owner %+v, %v", owner, err)
	}
	docs, err := NewDocumentRepository(db).List(ctx, owner.ID, domain.DocumentFilter{}, 10, 0)
	if err != nil || len(docs) != 1 || docs[0].Reference != "" {
		t.Errorf("documents after the migration %+v, %v", docs, err)
	}
	for _, gone := range []string{"users", "refresh_tokens", "password_resets"} {
		var n int
		db.read.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, gone).Scan(&n)
		if n != 0 {
			t.Errorf("table %s survived", gone)
		}
	}
	var fk int
	db.write.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk)
	if fk != 1 {
		t.Error("foreign keys were left off after the migration")
	}
}
