package usecase

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/platform/token"
)

// Passwords implements changing a password and the recovery of a forgotten
// one.
type Passwords struct {
	identity *Identity
	repos    Repositories
	hasher   PasswordHasher
	mailer   Mailer
	appURL   string
	resetTTL time.Duration
	now      Clock
	logger   *slog.Logger
	audit    *Auditor
}

// PasswordsConfig collects the dependencies.
type PasswordsConfig struct {
	Identity     *Identity
	Repositories Repositories
	Hasher       PasswordHasher
	Mailer       Mailer
	// AppURL is where the platform is served; the reset link is built from it.
	AppURL   string
	ResetTTL time.Duration
	Now      Clock
	Logger   *slog.Logger
}

// NewPasswords wires the use case.
func NewPasswords(cfg PasswordsConfig) *Passwords {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Passwords{
		identity: cfg.Identity,
		repos:    cfg.Repositories,
		hasher:   cfg.Hasher,
		mailer:   cfg.Mailer,
		appURL:   cfg.AppURL,
		resetTTL: cfg.ResetTTL,
		now:      cfg.Now,
		logger:   cfg.Logger,
		audit:    NewAuditor(cfg.Repositories.Audit, cfg.Now, cfg.Logger),
	}
}

// Change replaces a password for someone who knows the current one.
//
// It ends every other session at once. Revoking the refresh tokens is not
// enough on its own: an access token is stateless, so the new
// password_changed_at is what makes the ones already in circulation stop
// working.
func (p *Passwords) Change(ctx context.Context, caller *Caller, current, next string) error {
	v := &domain.ValidationError{}
	domain.ValidatePassword(v, "new_password", next)
	if err := v.OrNil(); err != nil {
		return err
	}
	if err := p.hasher.Verify(current, caller.User.PasswordHash); err != nil {
		return fmt.Errorf("change password: %w", domain.ErrInvalidCredentials)
	}

	hash, err := p.hasher.Hash(next)
	if err != nil {
		return fmt.Errorf("change password: hash: %w", err)
	}
	now := p.now().UTC()

	err = p.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.Users.UpdatePassword(ctx, caller.User.ID, hash, now); err != nil {
			return err
		}
		if err := repos.Sessions.RevokeAllForUser(ctx, caller.User.ID, now); err != nil {
			return err
		}
		// Any reset link still in an inbox belongs to the old password.
		if err := repos.Resets.InvalidateForUser(ctx, caller.User.ID, now); err != nil {
			return err
		}
		return p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPasswordChanged,
			EntityType:     "user",
			EntityID:       &caller.User.ID,
			Fields:         []string{"password_hash"},
		})
	})
	if err != nil {
		return err
	}

	// Told afterwards, and only to the address that owns the account: a change
	// nobody expected is the first sign of a stolen session.
	if p.mailer != nil {
		if err := p.mailer.Send(ctx, caller.User.Email,
			"Sua senha no Imobiliary foi alterada",
			passwordChangedMessage(caller.User.Name),
		); err != nil {
			p.logger.Error("could not send the password-change notice", slog.Any("error", err))
		}
	}
	return nil
}

// Forget starts recovery for an address.
//
// It answers the same whatever the address is, and reports no error to the
// caller: telling anyone whether an address has an account would turn this
// into a directory of the platform's customers. What goes wrong is logged.
func (p *Passwords) Forget(ctx context.Context, email string) {
	email = domain.NormalizeEmail(email)
	user, err := p.repos.Users.ByEmail(ctx, email)
	if errors.Is(err, domain.ErrNotFound) {
		return
	}
	if err != nil {
		p.logger.Error("could not look up an account for recovery", slog.Any("error", err))
		return
	}

	secret, err := token.NewSecret()
	if err != nil {
		p.logger.Error("could not create a reset secret", slog.Any("error", err))
		return
	}
	now := p.now().UTC()
	reset := &domain.PasswordReset{
		ID:        uuid.NewV7(),
		UserID:    user.ID,
		TokenHash: token.HashSecret(secret),
		ExpiresAt: now.Add(p.resetTTL),
		CreatedAt: now,
	}
	if err := p.repos.Resets.Create(ctx, reset); err != nil {
		p.logger.Error("could not store a reset token", slog.Any("error", err))
		return
	}
	if err := p.audit.Record(ctx, AuditEntry{
		ActorID:    &user.ID,
		Action:     domain.ActionPasswordResetAsked,
		EntityType: "user",
		EntityID:   &user.ID,
	}); err != nil {
		p.logger.Error("could not record the reset request", slog.Any("error", err))
	}

	if p.mailer == nil {
		return
	}
	link := p.appURL + "/redefinir-senha?token=" + url.QueryEscape(secret)
	if err := p.mailer.Send(ctx, user.Email,
		"Redefinir sua senha no Imobiliary",
		passwordResetMessage(user.Name, link, int(p.resetTTL.Minutes())),
	); err != nil {
		p.logger.Error("could not send the reset link", slog.Any("error", err))
	}
}

// Reset sets a new password from a link, for someone who cannot sign in.
func (p *Passwords) Reset(ctx context.Context, secret, password string) error {
	v := &domain.ValidationError{}
	domain.ValidatePassword(v, "password", password)
	if err := v.OrNil(); err != nil {
		return err
	}

	now := p.now().UTC()
	reset, err := p.repos.Resets.ByHash(ctx, token.HashSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return err
	}
	if !reset.IsUsable(now) {
		return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
	}

	hash, err := p.hasher.Hash(password)
	if err != nil {
		return fmt.Errorf("reset password: hash: %w", err)
	}

	return p.identity.tx.InTx(ctx, func(repos Repositories) error {
		// Spending the link is a conditional update, so two requests carrying
		// the same one cannot both set a password.
		if err := repos.Resets.Consume(ctx, reset.ID, now); err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return fmt.Errorf("reset password: %w", domain.ErrInvalidCredentials)
			}
			return err
		}
		if err := repos.Users.UpdatePassword(ctx, reset.UserID, hash, now); err != nil {
			return err
		}
		// Whoever was signed in with the old password no longer is. Someone
		// resetting a password is often doing it because of exactly that.
		if err := repos.Sessions.RevokeAllForUser(ctx, reset.UserID, now); err != nil {
			return err
		}
		if err := repos.Resets.InvalidateForUser(ctx, reset.UserID, now); err != nil {
			return err
		}
		return p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			ActorID:    &reset.UserID,
			Action:     domain.ActionPasswordResetDone,
			EntityType: "user",
			EntityID:   &reset.UserID,
			Fields:     []string{"password_hash"},
		})
	})
}
