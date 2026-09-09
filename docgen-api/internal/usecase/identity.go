package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/platform/token"
)

// dummyHash is a valid argon2id hash of a value nobody knows. Login verifies
// against it when no account matches the address, so that a request for an
// unknown account costs the same as one for a known account with a wrong
// password. Without it, response time alone would reveal which addresses are
// registered.
const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$" +
	"c29tZXNhbHRzb21lc2FsdA$YXJiaXRyYXJ5ZGlnZXN0dmFsdWV0aGF0bmV2ZXJtYXRjaGVz"

// Session is the credential pair handed to a client after authentication.
type Session struct {
	User             *domain.User
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
}

// Identity implements registration, login and the refresh-token lifecycle.
type Identity struct {
	users      UserRepository
	sessions   SessionRepository
	hasher     PasswordHasher
	tokens     TokenIssuer
	refreshTTL time.Duration
	now        Clock
}

// IdentityConfig collects the dependencies of the Identity use case.
type IdentityConfig struct {
	Users      UserRepository
	Sessions   SessionRepository
	Hasher     PasswordHasher
	Tokens     TokenIssuer
	RefreshTTL time.Duration
	Now        Clock
}

// NewIdentity wires the Identity use case.
func NewIdentity(cfg IdentityConfig) *Identity {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Identity{
		users:      cfg.Users,
		sessions:   cfg.Sessions,
		hasher:     cfg.Hasher,
		tokens:     cfg.Tokens,
		refreshTTL: cfg.RefreshTTL,
		now:        cfg.Now,
	}
}

// Register creates an account.
func (i *Identity) Register(ctx context.Context, email, name, password string) (*domain.User, error) {
	email = domain.NormalizeEmail(email)
	if err := domain.ValidateRegistration(email, name, password); err != nil {
		return nil, err
	}

	hash, err := i.hasher.Hash(password)
	if err != nil {
		return nil, fmt.Errorf("register: hash password: %w", err)
	}

	now := i.now().UTC()
	user := &domain.User{
		ID:           uuid.NewV7(),
		Email:        email,
		Name:         name,
		PasswordHash: hash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := i.users.Create(ctx, user); err != nil {
		return nil, err
	}
	return user, nil
}

// Login exchanges credentials for a session.
func (i *Identity) Login(ctx context.Context, email, password string) (*Session, error) {
	user, err := i.users.ByEmail(ctx, domain.NormalizeEmail(email))
	if errors.Is(err, domain.ErrNotFound) {
		// Spend the same work as a real verification before failing.
		_ = i.hasher.Verify(password, dummyHash)
		return nil, fmt.Errorf("login: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}

	if err := i.hasher.Verify(password, user.PasswordHash); err != nil {
		return nil, fmt.Errorf("login: %w", domain.ErrInvalidCredentials)
	}
	return i.startSession(ctx, user, nil)
}

// Refresh exchanges a refresh secret for a new session and invalidates the old
// one.
//
// Presenting a secret that was already exchanged means two parties hold it, and
// there is no way to tell the legitimate owner from a thief. The only safe
// response is to end every session of that account.
func (i *Identity) Refresh(ctx context.Context, secret string) (*Session, error) {
	now := i.now().UTC()

	stored, err := i.sessions.ByHash(ctx, token.HashRefreshSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("refresh: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}

	if stored.IsConsumed() {
		if err := i.sessions.RevokeAllForUser(ctx, stored.UserID, now); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("refresh: %w", domain.ErrSessionReused)
	}
	if !stored.IsUsable(now) {
		return nil, fmt.Errorf("refresh: %w", domain.ErrSessionExpired)
	}

	user, err := i.users.ByID(ctx, stored.UserID)
	if err != nil {
		return nil, err
	}
	return i.startSession(ctx, user, stored)
}

// Logout revokes the session a refresh secret belongs to.
//
// An unknown secret is not an error: the caller wanted the session gone, and it
// is. Reporting otherwise would turn logout into an oracle for guessing valid
// secrets.
func (i *Identity) Logout(ctx context.Context, secret string) error {
	stored, err := i.sessions.ByHash(ctx, token.HashRefreshSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return i.sessions.Revoke(ctx, stored.ID, i.now().UTC())
}

// Authenticate resolves the account behind an access token.
func (i *Identity) Authenticate(ctx context.Context, accessToken string) (*domain.User, error) {
	userID, err := i.tokens.ParseAccess(accessToken)
	if err != nil {
		return nil, err
	}

	user, err := i.users.ByID(ctx, userID)
	if errors.Is(err, domain.ErrNotFound) {
		// The token is well formed but the account is gone.
		return nil, fmt.Errorf("authenticate: %w", token.ErrInvalidToken)
	}
	if err != nil {
		return nil, err
	}
	return user, nil
}

// startSession mints a token pair. When previous is non-nil the new refresh
// token replaces it in a single atomic rotation; otherwise it opens a new chain.
func (i *Identity) startSession(ctx context.Context, user *domain.User, previous *domain.RefreshToken) (*Session, error) {
	now := i.now().UTC()

	secret, err := token.NewRefreshSecret()
	if err != nil {
		return nil, err
	}

	refresh := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: token.HashRefreshSecret(secret),
		ExpiresAt: now.Add(i.refreshTTL),
		CreatedAt: now,
	}

	if previous == nil {
		if err := i.sessions.Create(ctx, refresh); err != nil {
			return nil, err
		}
	} else {
		refresh.ParentID = &previous.ID
		if err := i.sessions.Rotate(ctx, previous.ID, now, refresh); err != nil {
			// Losing the race means another request consumed the same secret
			// concurrently, which is indistinguishable from a replay.
			if errors.Is(err, domain.ErrSessionReused) {
				if revokeErr := i.sessions.RevokeAllForUser(ctx, user.ID, now); revokeErr != nil {
					return nil, revokeErr
				}
			}
			return nil, err
		}
	}

	access, accessExpiresAt, err := i.tokens.IssueAccess(user.ID)
	if err != nil {
		return nil, err
	}

	return &Session{
		User:             user,
		AccessToken:      access,
		AccessExpiresAt:  accessExpiresAt,
		RefreshToken:     secret,
		RefreshExpiresAt: refresh.ExpiresAt,
	}, nil
}
