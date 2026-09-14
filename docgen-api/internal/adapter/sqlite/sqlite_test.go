//go:build integration

package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
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

func newTestUser(t *testing.T, ctx context.Context, db *DB) *domain.User {
	t.Helper()

	now := time.Now().UTC().Truncate(time.Microsecond)
	u := &domain.User{
		ID:           uuid.NewV7(),
		Email:        "ada+" + uuid.NewV4().String() + "@example.com",
		Name:         "Ada Lovelace",
		PasswordHash: "$argon2id$stub",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := NewUserRepository(db).Create(ctx, u); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u
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

func TestUserRepositoryRoundTrip(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	repo := NewUserRepository(db)

	want := newTestUser(t, ctx, db)

	got, err := repo.ByEmail(ctx, want.Email)
	if err != nil {
		t.Fatalf("ByEmail: %v", err)
	}
	if got.ID != want.ID || got.Name != want.Name || got.PasswordHash != want.PasswordHash {
		t.Errorf("ByEmail returned %+v, want %+v", got, want)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) {
		t.Errorf("CreatedAt = %v, want %v", got.CreatedAt, want.CreatedAt)
	}

	if _, err := repo.ByID(ctx, want.ID); err != nil {
		t.Errorf("ByID: %v", err)
	}
	if _, err := repo.ByEmail(ctx, "nobody@example.com"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("ByEmail on a missing account = %v, want ErrNotFound", err)
	}
}

func TestUserRepositoryRejectsDuplicateEmail(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	repo := NewUserRepository(db)

	first := newTestUser(t, ctx, db)
	duplicate := &domain.User{
		ID:           uuid.NewV7(),
		Email:        first.Email,
		Name:         "Impostor",
		PasswordHash: "$argon2id$stub",
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}

	if err := repo.Create(ctx, duplicate); !errors.Is(err, domain.ErrAlreadyExists) {
		t.Errorf("Create with a taken email = %v, want ErrAlreadyExists", err)
	}
}

// TestSessionRotationDetectsReuse is the security-critical case: a refresh
// token may be exchanged exactly once, and a second attempt must be reported as
// a replay rather than silently issuing another session.
func TestSessionRotationDetectsReuse(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	sessions := NewSessionRepository(db)
	user := newTestUser(t, ctx, db)
	now := time.Now().UTC()

	original := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: []byte("hash-of-the-first-secret-000000000"),
		ExpiresAt: now.Add(time.Hour),
		CreatedAt: now,
	}
	if err := sessions.Create(ctx, original); err != nil {
		t.Fatalf("create refresh token: %v", err)
	}

	stored, err := sessions.ByHash(ctx, original.TokenHash)
	if err != nil {
		t.Fatalf("ByHash: %v", err)
	}
	if !stored.IsUsable(now) {
		t.Fatal("freshly created token is not usable")
	}

	successor := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: []byte("hash-of-the-second-secret-00000000"),
		ParentID:  &original.ID,
		ExpiresAt: now.Add(time.Hour),
		CreatedAt: now,
	}
	if err := sessions.Rotate(ctx, original.ID, now, successor); err != nil {
		t.Fatalf("first rotation: %v", err)
	}

	// Replaying the original must fail, whatever successor is offered.
	replay := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: []byte("hash-of-a-third-secret-00000000000"),
		ParentID:  &original.ID,
		ExpiresAt: now.Add(time.Hour),
		CreatedAt: now,
	}
	if err := sessions.Rotate(ctx, original.ID, now, replay); !errors.Is(err, domain.ErrSessionReused) {
		t.Errorf("replaying a consumed token = %v, want ErrSessionReused", err)
	}

	// The successor stays usable until the chain is revoked.
	if _, err := sessions.ByHash(ctx, successor.TokenHash); err != nil {
		t.Fatalf("successor lookup: %v", err)
	}
	if err := sessions.RevokeAllForUser(ctx, user.ID, now); err != nil {
		t.Fatalf("revoke chain: %v", err)
	}

	after, err := sessions.ByHash(ctx, successor.TokenHash)
	if err != nil {
		t.Fatalf("successor lookup after revocation: %v", err)
	}
	if after.IsUsable(now) {
		t.Error("successor is still usable after the chain was revoked")
	}
}

func TestSessionDeleteExpired(t *testing.T) {
	ctx := t.Context()
	db := openTestDB(t)
	sessions := NewSessionRepository(db)
	user := newTestUser(t, ctx, db)
	now := time.Now().UTC()

	expired := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: []byte("expired-token-hash-0000000000000000"),
		ExpiresAt: now.Add(-time.Hour),
		CreatedAt: now.Add(-2 * time.Hour),
	}
	if err := sessions.Create(ctx, expired); err != nil {
		t.Fatalf("create expired token: %v", err)
	}

	removed, err := sessions.DeleteExpired(ctx, now)
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if removed != 1 {
		t.Errorf("DeleteExpired removed %d rows, want 1", removed)
	}
	if _, err := sessions.ByHash(ctx, expired.TokenHash); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("expired token still present: %v", err)
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
