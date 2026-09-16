package usecase

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/platform/token"
	"imobiliary/internal/platform/totp"
)

// MFA implements the second factor: enrolling one, proving it, and completing
// a sign-in that stopped to ask for it.
type MFA struct {
	identity *Identity
	repos    Repositories
	sealer   Sealer
	// issuerName is what an authenticator app shows above the code.
	issuerName string
	now        Clock
	logger     *slog.Logger
	audit      *Auditor
}

// MFAConfig collects the dependencies of the second factor.
type MFAConfig struct {
	Identity     *Identity
	Repositories Repositories
	Sealer       Sealer
	IssuerName   string
	Now          Clock
	Logger       *slog.Logger
}

// NewMFA wires the second factor.
func NewMFA(cfg MFAConfig) *MFA {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.IssuerName == "" {
		cfg.IssuerName = "Imobiliary"
	}
	return &MFA{
		identity:   cfg.Identity,
		repos:      cfg.Repositories,
		sealer:     cfg.Sealer,
		issuerName: cfg.IssuerName,
		now:        cfg.Now,
		logger:     cfg.Logger,
		audit:      NewAuditor(cfg.Repositories.Audit, cfg.Now, cfg.Logger),
	}
}

// Enrollment is what the setup screen shows: the secret, in the two forms an
// app can take it.
type Enrollment struct {
	Secret string
	URI    string
}

// sealContext names where the secret lives, so a ciphertext moved to another
// row cannot be opened.
const (
	totpTable  = "user_totp"
	totpColumn = "secret"
)

// StartEnrollment generates a secret and stores it unconfirmed.
//
// Unconfirmed matters: an enrolment that already blocked sign-in would lock
// out anyone whose app scanned the code and then failed to produce a matching
// one. Nothing changes until Confirm proves a code from it.
func (m *MFA) StartEnrollment(ctx context.Context, caller *Caller) (*Enrollment, error) {
	if caller.User.HasTOTP() {
		// Replacing a working second factor means disabling it first, with the
		// password, rather than quietly overwriting it.
		return nil, fmt.Errorf("start enrollment: %w", domain.ErrConflict)
	}

	secret, err := totp.NewSecret()
	if err != nil {
		return nil, err
	}
	sealed, err := m.sealer.Seal([]byte(secret), totpTable, totpColumn, caller.User.ID)
	if err != nil {
		return nil, err
	}
	err = m.repos.MFA.SaveEnrollment(ctx, &domain.TOTPEnrollment{
		UserID:    caller.User.ID,
		Secret:    sealed,
		CreatedAt: m.now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	return &Enrollment{
		Secret: secret,
		URI:    totp.URI(m.issuerName, caller.User.Email, secret),
	}, nil
}

// Confirm proves a code from the enrolment and turns the second factor on,
// handing back the recovery codes, which exist in the clear only here.
func (m *MFA) Confirm(ctx context.Context, caller *Caller, code string) ([]string, error) {
	enrollment, err := m.repos.MFA.Enrollment(ctx, caller.User.ID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("confirm totp: %w", domain.ErrConflict)
	}
	if err != nil {
		return nil, err
	}

	secret, err := m.openSecret(caller.User.ID, enrollment)
	if err != nil {
		return nil, err
	}
	step, ok := totp.Verify(secret, code, m.now(), enrollment.LastUsedStep)
	if !ok {
		return nil, fmt.Errorf("confirm totp: %w", domain.ErrInvalidCredentials)
	}

	now := m.now().UTC()
	codes, err := totp.NewRecoveryCodes(domain.RecoveryCodeCount)
	if err != nil {
		return nil, err
	}
	hashes := make([][]byte, 0, len(codes))
	for _, c := range codes {
		hashes = append(hashes, totp.HashRecoveryCode(c))
	}

	err = m.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.MFA.Confirm(ctx, caller.User.ID, now, step); err != nil {
			return err
		}
		if err := repos.Users.SetTOTPConfirmed(ctx, caller.User.ID, &now); err != nil {
			return err
		}
		if err := repos.MFA.ReplaceRecoveryCodes(ctx, caller.User.ID, hashes); err != nil {
			return err
		}
		return m.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionTOTPEnabled,
			EntityType:     "user",
			EntityID:       &caller.User.ID,
		})
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

// Disable turns the second factor off, which takes the password again: someone
// who walked up to an unlocked screen must not be able to remove it.
//
// An administrator may not disable it at all, because the rule is that the
// account which manages members carries one.
func (m *MFA) Disable(ctx context.Context, caller *Caller, password string) error {
	if domain.AdminsMustHaveTOTP(caller.Role) {
		return fmt.Errorf("disable totp: %w", domain.ErrPermissionDenied)
	}
	if err := m.identity.hasher.Verify(password, caller.User.PasswordHash); err != nil {
		return fmt.Errorf("disable totp: %w", domain.ErrInvalidCredentials)
	}

	return m.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.MFA.DeleteEnrollment(ctx, caller.User.ID); err != nil {
			return err
		}
		if err := repos.Users.SetTOTPConfirmed(ctx, caller.User.ID, nil); err != nil {
			return err
		}
		return m.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionTOTPDisabled,
			EntityType:     "user",
			EntityID:       &caller.User.ID,
		})
	})
}

// RegenerateRecoveryCodes hands out a new list and invalidates the old one, so
// a list printed months ago stops working the moment a new one is made.
func (m *MFA) RegenerateRecoveryCodes(ctx context.Context, caller *Caller, password string) ([]string, error) {
	if !caller.User.HasTOTP() {
		return nil, fmt.Errorf("recovery codes: %w", domain.ErrConflict)
	}
	if err := m.identity.hasher.Verify(password, caller.User.PasswordHash); err != nil {
		return nil, fmt.Errorf("recovery codes: %w", domain.ErrInvalidCredentials)
	}

	codes, err := totp.NewRecoveryCodes(domain.RecoveryCodeCount)
	if err != nil {
		return nil, err
	}
	hashes := make([][]byte, 0, len(codes))
	for _, c := range codes {
		hashes = append(hashes, totp.HashRecoveryCode(c))
	}
	if err := m.repos.MFA.ReplaceRecoveryCodes(ctx, caller.User.ID, hashes); err != nil {
		return nil, err
	}
	return codes, nil
}

// RemainingRecoveryCodes is how many of the list are still unused, which is
// what the settings screen shows.
func (m *MFA) RemainingRecoveryCodes(ctx context.Context, caller *Caller) (int, error) {
	return m.repos.MFA.CountUnusedRecoveryCodes(ctx, caller.User.ID)
}

// CompleteSignIn finishes a sign-in that stopped for the second factor.
//
// code is either a six-digit code from the app or one of the recovery codes.
// Both spend the challenge, so a captured challenge cannot be tried twice.
func (m *MFA) CompleteSignIn(ctx context.Context, challenge, code string, organizationID uuid.UUID) (*Session, error) {
	now := m.now().UTC()

	stored, err := m.repos.MFA.ChallengeByHash(ctx, token.HashSecret(challenge))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("complete sign in: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if !stored.IsUsable(now) {
		return nil, fmt.Errorf("complete sign in: %w", domain.ErrSessionExpired)
	}
	// Spent before the code is checked, and spent whether or not the code is
	// right: one challenge is one attempt, so guessing costs a new password
	// exchange every time.
	if err := m.repos.MFA.ConsumeChallenge(ctx, stored.ID, now); err != nil {
		return nil, fmt.Errorf("complete sign in: %w", domain.ErrInvalidCredentials)
	}

	user, err := m.repos.Users.ByID(ctx, stored.UserID)
	if err != nil {
		return nil, err
	}
	enrollment, err := m.repos.MFA.Enrollment(ctx, user.ID)
	if err != nil {
		return nil, err
	}

	if err := m.verifyCode(ctx, user, enrollment, code); err != nil {
		return nil, err
	}

	memberships, err := m.repos.Memberships.ForUser(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if len(memberships) == 0 {
		return nil, fmt.Errorf("complete sign in: %w", domain.ErrPermissionDenied)
	}
	return m.identity.openSession(ctx, user, memberships, organizationID)
}

// verifyCode accepts either a code from the app or a recovery code, and
// records what it accepted so it cannot be used twice.
func (m *MFA) verifyCode(ctx context.Context, user *domain.User, enrollment *domain.TOTPEnrollment, code string) error {
	secret, err := m.openSecret(user.ID, enrollment)
	if err != nil {
		return err
	}
	now := m.now().UTC()

	if step, ok := totp.Verify(secret, code, now, enrollment.LastUsedStep); ok {
		return m.repos.MFA.RecordStep(ctx, user.ID, step)
	}

	// Not a valid code: it may still be one of the recovery codes.
	err = m.repos.MFA.ConsumeRecoveryCode(ctx, user.ID, totp.HashRecoveryCode(code), now)
	if errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("verify code: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return err
	}
	return m.audit.Record(ctx, AuditEntry{
		ActorID:    &user.ID,
		Action:     domain.ActionRecoveryCodeUsed,
		EntityType: "user",
		EntityID:   &user.ID,
	})
}

func (m *MFA) openSecret(userID uuid.UUID, enrollment *domain.TOTPEnrollment) (string, error) {
	secret, err := m.sealer.Open(enrollment.Secret, totpTable, totpColumn, userID)
	if err != nil {
		return "", fmt.Errorf("open totp secret: %w", err)
	}
	return string(secret), nil
}
