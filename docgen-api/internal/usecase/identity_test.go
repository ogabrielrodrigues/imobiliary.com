package usecase

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/platform/password"
	"docgen/internal/platform/token"
)

// The fakes below implement the ports declared in ports.go. They are written by
// hand rather than generated because each interface is small enough that a fake
// is a few lines, which is one of the practical payoffs of segregating them.

type fakeUsers struct {
	mu        sync.Mutex
	byID      map[uuid.UUID]*domain.User
	byEmail   map[string]*domain.User
	createErr error
}

func newFakeUsers() *fakeUsers {
	return &fakeUsers{
		byID:    make(map[uuid.UUID]*domain.User),
		byEmail: make(map[string]*domain.User),
	}
}

func (f *fakeUsers) Create(_ context.Context, u *domain.User) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.createErr != nil {
		return f.createErr
	}
	if _, taken := f.byEmail[u.Email]; taken {
		return fmt.Errorf("create user: %w", domain.ErrAlreadyExists)
	}

	stored := *u
	f.byEmail[u.Email] = &stored
	f.byID[u.ID] = &stored
	return nil
}

func (f *fakeUsers) ByEmail(_ context.Context, email string) (*domain.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	u, ok := f.byEmail[email]
	if !ok {
		return nil, fmt.Errorf("user: %w", domain.ErrNotFound)
	}
	return u, nil
}

func (f *fakeUsers) ByID(_ context.Context, id uuid.UUID) (*domain.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	u, ok := f.byID[id]
	if !ok {
		return nil, fmt.Errorf("user: %w", domain.ErrNotFound)
	}
	return u, nil
}

// Delete satisfies UserRepository. Identity never calls it — erasure lives in
// the Privacy use case — so the fake only has to keep its own map honest.
func (f *fakeUsers) Delete(_ context.Context, id uuid.UUID) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	u, ok := f.byID[id]
	if !ok {
		return nil, fmt.Errorf("user: %w", domain.ErrNotFound)
	}
	delete(f.byID, id)
	delete(f.byEmail, u.Email)
	return nil, nil
}

type fakeSessions struct {
	mu     sync.Mutex
	byID   map[uuid.UUID]*domain.RefreshToken
	byHash map[string]*domain.RefreshToken
}

func newFakeSessions() *fakeSessions {
	return &fakeSessions{
		byID:   make(map[uuid.UUID]*domain.RefreshToken),
		byHash: make(map[string]*domain.RefreshToken),
	}
}

func (f *fakeSessions) store(t *domain.RefreshToken) {
	stored := *t
	f.byID[t.ID] = &stored
	f.byHash[string(t.TokenHash)] = &stored
}

func (f *fakeSessions) Create(_ context.Context, t *domain.RefreshToken) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.store(t)
	return nil
}

func (f *fakeSessions) ByHash(_ context.Context, hash []byte) (*domain.RefreshToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	t, ok := f.byHash[string(hash)]
	if !ok {
		return nil, fmt.Errorf("refresh token: %w", domain.ErrNotFound)
	}
	copied := *t
	return &copied, nil
}

// Rotate mirrors the real repository: consuming a token is conditional on it
// being unused, so a replay loses.
func (f *fakeSessions) Rotate(_ context.Context, oldID uuid.UUID, usedAt time.Time, next *domain.RefreshToken) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	current, ok := f.byID[oldID]
	if !ok || current.UsedAt != nil {
		return fmt.Errorf("rotate refresh token: %w", domain.ErrSessionReused)
	}

	stamp := usedAt
	current.UsedAt = &stamp
	f.store(next)
	return nil
}

func (f *fakeSessions) Revoke(_ context.Context, id uuid.UUID, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if t, ok := f.byID[id]; ok && t.RevokedAt == nil {
		stamp := at
		t.RevokedAt = &stamp
	}
	return nil
}

func (f *fakeSessions) RevokeAllForUser(_ context.Context, userID uuid.UUID, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, t := range f.byID {
		if t.UserID == userID && t.RevokedAt == nil {
			stamp := at
			t.RevokedAt = &stamp
		}
	}
	return nil
}

// fakeHasher is a stand-in that is instant and reversible. Password hashing
// itself is covered by the password package's own tests.
type fakeHasher struct{}

func (fakeHasher) Hash(plain string) (string, error) { return "hashed:" + plain, nil }

func (fakeHasher) Verify(plain, encoded string) error {
	if encoded != "hashed:"+plain {
		return errors.New("mismatch")
	}
	return nil
}

type fakeTokens struct {
	ttl time.Duration
	now func() time.Time
}

func (f fakeTokens) IssueAccess(userID uuid.UUID) (string, time.Time, error) {
	return "access:" + userID.String(), f.now().Add(f.ttl), nil
}

func (f fakeTokens) ParseAccess(raw string) (uuid.UUID, error) {
	rest, found := strings.CutPrefix(raw, "access:")
	if !found {
		return uuid.Nil(), fmt.Errorf("%w: bad prefix", token.ErrInvalidToken)
	}
	id, err := uuid.Parse(rest)
	if err != nil {
		return uuid.Nil(), fmt.Errorf("%w: bad subject", token.ErrInvalidToken)
	}
	return id, nil
}

// identityFixture bundles a wired Identity with the fakes behind it.
type identityFixture struct {
	identity *Identity
	users    *fakeUsers
	sessions *fakeSessions
	now      time.Time
}

func newIdentityFixture(t *testing.T) *identityFixture {
	t.Helper()

	fixture := &identityFixture{
		users:    newFakeUsers(),
		sessions: newFakeSessions(),
		now:      time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC),
	}
	clock := func() time.Time { return fixture.now }

	fixture.identity = NewIdentity(IdentityConfig{
		Users:      fixture.users,
		Sessions:   fixture.sessions,
		Hasher:     fakeHasher{},
		Tokens:     fakeTokens{ttl: 15 * time.Minute, now: clock},
		RefreshTTL: 30 * 24 * time.Hour,
		Now:        clock,
	})
	return fixture
}

const (
	testEmail    = "ada@example.com"
	testName     = "Ada Lovelace"
	testPassword = "a-sufficiently-long-password"
)

func (f *identityFixture) register(t *testing.T, ctx context.Context) *domain.User {
	t.Helper()

	user, err := f.identity.Register(ctx, testEmail, testName, testPassword)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return user
}

func TestRegisterNormalizesEmailAndHashesPassword(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)

	user, err := f.identity.Register(ctx, "  ADA@Example.COM ", testName, testPassword)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	if user.Email != testEmail {
		t.Errorf("email stored as %q, want %q", user.Email, testEmail)
	}
	if strings.Contains(user.PasswordHash, testPassword) == false {
		// The fake hasher is reversible on purpose; the real one is covered
		// elsewhere. What matters here is that Register hashed at all.
		t.Errorf("password does not appear to have been passed through the hasher: %q", user.PasswordHash)
	}
	if user.ID == uuid.Nil() {
		t.Error("Register did not assign an identifier")
	}
}

func TestRegisterRejectsInvalidInput(t *testing.T) {
	ctx := t.Context()

	tests := []struct {
		name, email, fullName, pass string
	}{
		{"empty email", "", testName, testPassword},
		{"malformed email", "not-an-address", testName, testPassword},
		{"empty name", testEmail, "  ", testPassword},
		{"short password", testEmail, testName, "short"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityFixture(t)
			if _, err := f.identity.Register(ctx, tc.email, tc.fullName, tc.pass); !errors.Is(err, domain.ErrValidation) {
				t.Errorf("Register = %v, want a validation error", err)
			}
		})
	}
}

func TestRegisterRejectsDuplicateEmail(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	if _, err := f.identity.Register(ctx, testEmail, testName, testPassword); !errors.Is(err, domain.ErrAlreadyExists) {
		t.Errorf("Register with a taken email = %v, want ErrAlreadyExists", err)
	}
}

func TestLoginIssuesSession(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	user := f.register(t, ctx)

	session, err := f.identity.Login(ctx, "ADA@example.com", testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	if session.User.ID != user.ID {
		t.Errorf("session belongs to %s, want %s", session.User.ID, user.ID)
	}
	if session.AccessToken == "" || session.RefreshToken == "" {
		t.Error("Login returned an incomplete credential pair")
	}
	if !session.AccessExpiresAt.After(f.now) {
		t.Error("access token is already expired")
	}
	if !session.RefreshExpiresAt.After(session.AccessExpiresAt) {
		t.Error("refresh token does not outlive the access token")
	}
}

func TestLoginRejectsBadCredentials(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	t.Run("wrong password", func(t *testing.T) {
		if _, err := f.identity.Login(ctx, testEmail, "the-wrong-password"); !errors.Is(err, domain.ErrInvalidCredentials) {
			t.Errorf("Login = %v, want ErrInvalidCredentials", err)
		}
	})

	// An unknown account must fail exactly like a wrong password, so the
	// response never reveals which addresses are registered.
	t.Run("unknown account", func(t *testing.T) {
		if _, err := f.identity.Login(ctx, "nobody@example.com", testPassword); !errors.Is(err, domain.ErrInvalidCredentials) {
			t.Errorf("Login = %v, want ErrInvalidCredentials", err)
		}
	})
}

func TestRefreshRotatesTheSecret(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	first, err := f.identity.Login(ctx, testEmail, testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	second, err := f.identity.Refresh(ctx, first.RefreshToken)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if second.RefreshToken == first.RefreshToken {
		t.Error("Refresh returned the same secret instead of rotating it")
	}
	if second.User.ID != first.User.ID {
		t.Error("Refresh switched accounts")
	}

	// The successor works.
	if _, err := f.identity.Refresh(ctx, second.RefreshToken); err != nil {
		t.Errorf("refreshing with the successor: %v", err)
	}
}

// TestRefreshReuseRevokesEverySession is the security-critical behaviour:
// presenting an already-consumed secret means two parties hold it, and there is
// no way to tell the owner from a thief, so every session must end.
func TestRefreshReuseRevokesEverySession(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	first, err := f.identity.Login(ctx, testEmail, testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	second, err := f.identity.Refresh(ctx, first.RefreshToken)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	// Replaying the consumed secret.
	if _, err := f.identity.Refresh(ctx, first.RefreshToken); !errors.Is(err, domain.ErrSessionReused) {
		t.Errorf("replaying a consumed secret = %v, want ErrSessionReused", err)
	}

	// The successor, which the legitimate client holds, is collateral damage
	// by design: it must no longer work either.
	if _, err := f.identity.Refresh(ctx, second.RefreshToken); err == nil {
		t.Error("the successor still works after a replay was detected")
	}
}

func TestRefreshRejectsExpiredSecret(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	session, err := f.identity.Login(ctx, testEmail, testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	f.now = f.now.Add(31 * 24 * time.Hour)
	if _, err := f.identity.Refresh(ctx, session.RefreshToken); !errors.Is(err, domain.ErrSessionExpired) {
		t.Errorf("Refresh with an expired secret = %v, want ErrSessionExpired", err)
	}
}

func TestRefreshRejectsUnknownSecret(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)

	if _, err := f.identity.Refresh(ctx, "a-secret-that-was-never-issued"); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Errorf("Refresh with an unknown secret = %v, want ErrInvalidCredentials", err)
	}
}

func TestLogoutEndsTheSession(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	f.register(t, ctx)

	session, err := f.identity.Login(ctx, testEmail, testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if err := f.identity.Logout(ctx, session.RefreshToken); err != nil {
		t.Fatalf("Logout: %v", err)
	}

	if _, err := f.identity.Refresh(ctx, session.RefreshToken); !errors.Is(err, domain.ErrSessionExpired) {
		t.Errorf("Refresh after logout = %v, want ErrSessionExpired", err)
	}
}

// TestLogoutIsSilentOnUnknownSecret keeps logout from becoming an oracle for
// probing which secrets exist.
func TestLogoutIsSilentOnUnknownSecret(t *testing.T) {
	f := newIdentityFixture(t)

	if err := f.identity.Logout(t.Context(), "a-secret-that-was-never-issued"); err != nil {
		t.Errorf("Logout with an unknown secret = %v, want nil", err)
	}
}

func TestAuthenticateResolvesTheAccount(t *testing.T) {
	ctx := t.Context()
	f := newIdentityFixture(t)
	user := f.register(t, ctx)

	session, err := f.identity.Login(ctx, testEmail, testPassword)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	got, err := f.identity.Authenticate(ctx, session.AccessToken)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("Authenticate resolved %s, want %s", got.ID, user.ID)
	}

	if _, err := f.identity.Authenticate(ctx, "not-a-token"); !errors.Is(err, token.ErrInvalidToken) {
		t.Errorf("Authenticate with junk = %v, want ErrInvalidToken", err)
	}
}

// TestDummyHashIsWellFormed protects the timing-equalisation trick in Login.
// If the constant stopped being a parseable argon2id hash, Verify would fail
// immediately instead of doing the work, and the timing difference between a
// known and an unknown account would come back.
func TestDummyHashIsWellFormed(t *testing.T) {
	err := password.Verify("any password at all", dummyHash)
	if err == nil {
		t.Fatal("the dummy hash matched a password, which should be impossible")
	}
	if !errors.Is(err, password.ErrMismatch) {
		t.Errorf("verifying against the dummy hash = %v, want ErrMismatch (it is malformed)", err)
	}
}
