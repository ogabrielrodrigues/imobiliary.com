package usecase

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/platform/token"
)

// Passwords implements changing a password and recovering a forgotten one.
//
// It sits beside Identity rather than inside it because the two answer
// different questions. Identity decides who someone is; this decides whether
// they may replace the secret that proves it, which is the operation an
// attacker wants most and the one a legitimate user reaches for after losing
// control of an account.
type Passwords struct {
	users      UserRepository
	sessions   SessionRepository
	resets     PasswordResetRepository
	hasher     PasswordHasher
	tokens     TokenIssuer
	mailer     Mailer
	appURL     string
	resetTTL   time.Duration
	refreshTTL time.Duration
	now        Clock
	logger     *slog.Logger
}

// PasswordsConfig collects the dependencies of the Passwords use case.
type PasswordsConfig struct {
	Users    UserRepository
	Sessions SessionRepository
	Resets   PasswordResetRepository
	Hasher   PasswordHasher
	Tokens   TokenIssuer
	Mailer   Mailer
	// AppURL is where the reset link points, without a trailing slash.
	AppURL   string
	ResetTTL time.Duration
	// RefreshTTL matches the one Identity uses: the session handed back after a
	// change is an ordinary session and must not outlive a normal one.
	RefreshTTL time.Duration
	Now        Clock
	Logger     *slog.Logger
}

// NewPasswords wires the Passwords use case.
func NewPasswords(cfg PasswordsConfig) *Passwords {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Passwords{
		users:      cfg.Users,
		sessions:   cfg.Sessions,
		resets:     cfg.Resets,
		hasher:     cfg.Hasher,
		tokens:     cfg.Tokens,
		mailer:     cfg.Mailer,
		appURL:     strings.TrimRight(cfg.AppURL, "/"),
		resetTTL:   cfg.ResetTTL,
		refreshTTL: cfg.RefreshTTL,
		now:        cfg.Now,
		logger:     cfg.Logger,
	}
}

// Change replaces the password of an authenticated account and returns a fresh
// session.
//
// Every other session of the account ends. That is the whole point: someone
// changes their password because they think a second party has it, and a change
// that left that party signed in would be theatre. The caller gets a new
// session back so the browser doing the changing survives its own request.
func (p *Passwords) Change(ctx context.Context, userID uuid.UUID, current, next string) (*Session, error) {
	user, err := p.users.ByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	if err := p.hasher.Verify(current, user.PasswordHash); err != nil {
		return nil, fmt.Errorf("change password: %w", domain.ErrInvalidCredentials)
	}
	if err := domain.ValidatePasswordChange(next); err != nil {
		return nil, err
	}
	// Not a security control — it is trivially defeated by changing one
	// character — but someone who submits the password they already have meant
	// to change something and did not.
	if p.hasher.Verify(next, user.PasswordHash) == nil {
		v := &domain.ValidationError{}
		v.Add("new_password", "must be different from the current password")
		return nil, v
	}

	if err := p.apply(ctx, user, next); err != nil {
		return nil, err
	}
	return p.startSession(ctx, user)
}

// RequestReset mails a one-time link to the address, if it belongs to anyone.
//
// It reports nothing about whether it did. An endpoint that answered
// differently for a known and an unknown address would be a way to ask which
// addresses have accounts here, and it is reachable without credentials.
func (p *Passwords) RequestReset(ctx context.Context, email string) error {
	user, err := p.users.ByEmail(ctx, domain.NormalizeEmail(email))
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}

	secret, err := token.NewRefreshSecret()
	if err != nil {
		return err
	}

	now := p.now().UTC()
	reset := &domain.PasswordReset{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: token.HashRefreshSecret(secret),
		ExpiresAt: now.Add(p.resetTTL),
		CreatedAt: now,
	}
	// Any link already in an inbox stops working. Two live tokens would mean
	// two chances for whoever reads the mailbox.
	if err := p.resets.InvalidateForUser(ctx, user.ID, now); err != nil {
		return err
	}
	if err := p.resets.Create(ctx, reset); err != nil {
		return err
	}

	return p.mailer.Send(ctx, user.Email,
		"Redefinição de senha — Imobiliary Docs",
		resetMessage(user.Name, p.resetLink(secret), p.resetTTL),
	)
}

// Reset sets a new password from a one-time token.
//
// Every session ends, including the one that asked. Whoever holds this token
// proved control of the mailbox and nothing else, and the premise of the whole
// flow is that the account may already be in someone else's hands.
func (p *Passwords) Reset(ctx context.Context, secret, next string) error {
	if err := domain.ValidatePasswordChange(next); err != nil {
		return err
	}

	stored, err := p.resets.ByHash(ctx, token.HashRefreshSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return err
	}
	if !stored.IsUsable(p.now().UTC()) {
		return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
	}

	user, err := p.users.ByID(ctx, stored.UserID)
	if err != nil {
		return err
	}

	// Consumed before the password is written, and conditional on it still
	// being unused, so two requests racing the same link cannot both proceed.
	if err := p.resets.Consume(ctx, stored.ID, p.now().UTC()); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
		}
		return err
	}

	return p.apply(ctx, user, next)
}

// apply writes the new password and ends every session of the account.
//
// It deliberately opens none: a reset leaves nobody signed in, and the change
// flow adds its own afterwards. Minting one here and discarding it in the reset
// path would leave a live refresh chain nobody asked for.
func (p *Passwords) apply(ctx context.Context, user *domain.User, next string) error {
	hash, err := p.hasher.Hash(next)
	if err != nil {
		return fmt.Errorf("change password: hash: %w", err)
	}

	now := p.now().UTC()
	if err := p.users.UpdatePassword(ctx, user.ID, hash, now); err != nil {
		return err
	}
	if err := p.sessions.RevokeAllForUser(ctx, user.ID, now); err != nil {
		return err
	}
	// Links still in an inbox are worthless now, and leaving them live would
	// let an old mail undo the change.
	if err := p.resets.InvalidateForUser(ctx, user.ID, now); err != nil {
		return err
	}

	// Sent after the change, never before: if it fails, the password has still
	// changed, and refusing the request would be a lie about what happened.
	if err := p.mailer.Send(ctx, user.Email,
		"Sua senha foi alterada — Imobiliary Docs",
		changedMessage(user.Name),
	); err != nil {
		p.logger.Error("could not send the password-change notice",
			slog.Any("error", err))
	}

	user.PasswordHash = hash
	user.PasswordChangedAt = &now
	return nil
}

// startSession opens a fresh chain for a user whose credential just changed.
//
// Called only after PasswordChangedAt is set, so the token it mints is not
// itself rejected by the check that invalidates the ones issued before.
func (p *Passwords) startSession(ctx context.Context, user *domain.User) (*Session, error) {
	secret, err := token.NewRefreshSecret()
	if err != nil {
		return nil, err
	}

	now := p.now().UTC()
	refresh := &domain.RefreshToken{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: token.HashRefreshSecret(secret),
		ExpiresAt: now.Add(p.refreshTTL),
		CreatedAt: now,
	}
	if err := p.sessions.Create(ctx, refresh); err != nil {
		return nil, err
	}

	access, accessExpiresAt, err := p.tokens.IssueAccess(user.ID)
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

// resetLink builds the address the mail points at.
func (p *Passwords) resetLink(secret string) string {
	return p.appURL + "/redefinir-senha?token=" + secret
}
