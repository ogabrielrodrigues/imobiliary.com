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
)

// dummyHash is a valid argon2id hash of a value nobody knows. Sign-in verifies
// against it when no account matches the address, so that a request for an
// unknown account costs the same as one for a known account with a wrong
// password. Without it, response time alone would reveal which addresses are
// registered.
const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$" +
	"c29tZXNhbHRzb21lc2FsdA$YXJiaXRyYXJ5ZGlnZXN0dmFsdWV0aGF0bmV2ZXJtYXRjaGVz"

// Session is the credential pair handed to a client that signed in.
type Session struct {
	User             *domain.User
	Organization     *domain.Organization
	Role             domain.Role
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
	// MFAEnrollmentRequired is set for an administrator who has not enrolled a
	// second factor yet. The session works, and the transport lets it reach
	// only the enrolment endpoints until it is cleared.
	MFAEnrollmentRequired bool
}

// SignInResult is what a password alone earns: either a session, or the
// challenge that asks for the second factor.
type SignInResult struct {
	Session *Session
	// Challenge is the secret the client sends back with the code. It exists
	// only when the account has a second factor.
	Challenge          string
	ChallengeExpiresAt time.Time
	// Organizations are the offices this account may work in, so a client that
	// has to ask which one can ask before completing the sign-in.
	Organizations []MembershipWithOrganization
}

// NeedsSecondFactor reports whether the sign-in stopped to ask for a code.
func (r *SignInResult) NeedsSecondFactor() bool { return r.Session == nil }

// Identity implements registration, sign-in, the refresh lifecycle and the
// checks every authenticated request makes.
type Identity struct {
	repos        Repositories
	tx           Transactor
	hasher       PasswordHasher
	tokens       TokenIssuer
	mailer       Mailer
	refreshTTL   time.Duration
	challengeTTL time.Duration
	now          Clock
	logger       *slog.Logger
	audit        *Auditor
}

// IdentityConfig collects the dependencies of the Identity use case.
type IdentityConfig struct {
	Repositories Repositories
	Transactor   Transactor
	Hasher       PasswordHasher
	Tokens       TokenIssuer
	// Mailer tells the owner of an address that someone tried to register it,
	// which is what lets registration answer the same for a taken address.
	Mailer       Mailer
	RefreshTTL   time.Duration
	ChallengeTTL time.Duration
	Now          Clock
	Logger       *slog.Logger
}

// NewIdentity wires the Identity use case.
func NewIdentity(cfg IdentityConfig) *Identity {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.ChallengeTTL == 0 {
		cfg.ChallengeTTL = 5 * time.Minute
	}
	return &Identity{
		repos:        cfg.Repositories,
		tx:           cfg.Transactor,
		hasher:       cfg.Hasher,
		tokens:       cfg.Tokens,
		mailer:       cfg.Mailer,
		refreshTTL:   cfg.RefreshTTL,
		challengeTTL: cfg.ChallengeTTL,
		now:          cfg.Now,
		logger:       cfg.Logger,
		audit:        &Auditor{repo: cfg.Repositories.Audit, now: cfg.Now, logger: cfg.Logger},
	}
}

// Registration is what someone types to open an account: their own details and
// the office the account will administer.
type Registration struct {
	Email            string
	Name             string
	Password         string
	OrganizationName string
	TermsVersion     string
}

// Register creates an account and the organisation it administers.
//
// A taken address is not an error the caller sees. Answering 409 would let
// anyone ask which addresses have accounts, undoing the care taken in sign-in
// and in the password reset. The owner is told instead, in the one place only
// they can read, and the caller gets the same answer either way.
func (i *Identity) Register(ctx context.Context, r Registration) (*domain.User, error) {
	email := domain.NormalizeEmail(r.Email)
	if err := domain.ValidateRegistration(email, r.Name, r.Password, r.OrganizationName); err != nil {
		return nil, err
	}
	if r.TermsVersion == "" {
		v := &domain.ValidationError{}
		v.Add("terms_version", "is required")
		return nil, v
	}

	// Hashed before the address is looked up, on both paths, so the time a
	// request takes cannot tell a taken address from a free one either.
	hash, err := i.hasher.Hash(r.Password)
	if err != nil {
		return nil, fmt.Errorf("register: hash password: %w", err)
	}

	existing, err := i.repos.Users.ByEmail(ctx, email)
	if err == nil {
		i.noticeExisting(ctx, existing)
		return nil, nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}

	now := i.now().UTC()
	organization := &domain.Organization{
		ID:        uuid.NewV7(),
		Name:      r.OrganizationName,
		CreatedAt: now,
		UpdatedAt: now,
	}
	user := &domain.User{
		ID:              uuid.NewV7(),
		Email:           email,
		Name:            r.Name,
		PasswordHash:    hash,
		CreatedAt:       now,
		UpdatedAt:       now,
		TermsAcceptedAt: &now,
		TermsVersion:    r.TermsVersion,
	}

	// One fact, one transaction: an account without its organisation, or an
	// organisation nobody administers, are both states nothing could recover
	// from.
	err = i.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.Organizations.Create(ctx, organization); err != nil {
			return err
		}
		if err := repos.Users.Create(ctx, user); err != nil {
			return err
		}
		membership := &domain.Membership{
			OrganizationID: organization.ID,
			UserID:         user.ID,
			Role:           domain.RoleAdmin,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if err := repos.Memberships.Create(ctx, membership); err != nil {
			return err
		}
		if err := i.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &organization.ID,
			ActorID:        &user.ID,
			Action:         domain.ActionOrganizationCreated,
			EntityType:     "organization",
			EntityID:       &organization.ID,
		}); err != nil {
			return err
		}
		return i.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &organization.ID,
			ActorID:        &user.ID,
			Action:         domain.ActionUserRegistered,
			EntityType:     "user",
			EntityID:       &user.ID,
		})
	})
	if err != nil {
		// Two registrations for the same address racing each other: the loser
		// gets the same silent answer as any other taken address.
		if errors.Is(err, domain.ErrAlreadyExists) {
			return nil, nil
		}
		return nil, err
	}
	return user, nil
}

// noticeExisting tells the owner of an address that someone tried to open an
// account with it. Failures are logged, never returned: reporting them would
// reveal that the address matched.
func (i *Identity) noticeExisting(ctx context.Context, user *domain.User) {
	if i.mailer == nil {
		return
	}
	if err := i.mailer.Send(ctx, user.Email,
		"Tentativa de cadastro com seu e-mail - Imobiliary",
		existingAccountMessage(user.Name),
	); err != nil {
		i.logger.Error("could not send the existing-account notice", slog.Any("error", err))
	}
}

// SignIn exchanges an address and a password for a session, or for the
// challenge that asks for the second factor.
//
// organizationID may be the nil UUID, which means "the only one, or the first
// by name". A client that showed a picker sends the choice back.
func (i *Identity) SignIn(ctx context.Context, email, password string, organizationID uuid.UUID) (*SignInResult, error) {
	user, err := i.repos.Users.ByEmail(ctx, domain.NormalizeEmail(email))
	if errors.Is(err, domain.ErrNotFound) {
		// Spend the same work as a real verification before failing.
		_ = i.hasher.Verify(password, dummyHash)
		return nil, fmt.Errorf("sign in: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if err := i.hasher.Verify(password, user.PasswordHash); err != nil {
		return nil, fmt.Errorf("sign in: %w", domain.ErrInvalidCredentials)
	}

	memberships, err := i.repos.Memberships.ForUser(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if len(memberships) == 0 {
		// The account exists but belongs to no office any more, which is what
		// a removed member sees. There is nothing to sign in to.
		return nil, fmt.Errorf("sign in: %w", domain.ErrPermissionDenied)
	}

	// The second factor comes before any session exists, so a stolen password
	// alone buys nothing that can be refreshed.
	if user.HasTOTP() {
		challenge, expiresAt, err := i.newChallenge(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		return &SignInResult{
			Challenge:          challenge,
			ChallengeExpiresAt: expiresAt,
			Organizations:      memberships,
		}, nil
	}

	session, err := i.openSession(ctx, user, memberships, organizationID)
	if err != nil {
		return nil, err
	}
	return &SignInResult{Session: session, Organizations: memberships}, nil
}

// newChallenge stores the short-lived proof that a password was accepted.
func (i *Identity) newChallenge(ctx context.Context, userID uuid.UUID) (string, time.Time, error) {
	secret, err := token.NewSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	now := i.now().UTC()
	challenge := &domain.MFAChallenge{
		ID:        uuid.NewV7(),
		UserID:    userID,
		TokenHash: token.HashSecret(secret),
		ExpiresAt: now.Add(i.challengeTTL),
		CreatedAt: now,
	}
	if err := i.repos.MFA.CreateChallenge(ctx, challenge); err != nil {
		return "", time.Time{}, err
	}
	return secret, challenge.ExpiresAt, nil
}

// openSession picks the organisation and mints the credential pair.
func (i *Identity) openSession(
	ctx context.Context,
	user *domain.User,
	memberships []MembershipWithOrganization,
	organizationID uuid.UUID,
) (*Session, error) {
	chosen := memberships[0]
	if organizationID != uuid.Nil() {
		found := false
		for _, m := range memberships {
			if m.Organization.ID == organizationID {
				chosen, found = m, true
				break
			}
		}
		if !found {
			// Asking for an office one does not belong to is refused as
			// permission, not as "no such organisation": the second would
			// confirm that it exists.
			return nil, fmt.Errorf("sign in: %w", domain.ErrPermissionDenied)
		}
	}
	return i.startSession(ctx, user, chosen, nil)
}

// startSession mints a token pair. When previous is non-nil the new refresh
// token replaces it in a single atomic rotation; otherwise it opens a chain.
func (i *Identity) startSession(
	ctx context.Context,
	user *domain.User,
	membership MembershipWithOrganization,
	previous *domain.RefreshToken,
) (*Session, error) {
	now := i.now().UTC()

	secret, err := token.NewSecret()
	if err != nil {
		return nil, err
	}
	refresh := &domain.RefreshToken{
		ID:             uuid.NewV7(),
		UserID:         user.ID,
		OrganizationID: membership.Organization.ID,
		TokenHash:      token.HashSecret(secret),
		ExpiresAt:      now.Add(i.refreshTTL),
		CreatedAt:      now,
	}

	if previous == nil {
		if err := i.repos.Sessions.Create(ctx, refresh); err != nil {
			return nil, err
		}
	} else {
		refresh.ParentID = &previous.ID
		if err := i.repos.Sessions.Rotate(ctx, previous.ID, now, refresh); err != nil {
			// Losing the race means another request consumed the same secret
			// concurrently, which is indistinguishable from a replay.
			if errors.Is(err, domain.ErrSessionReused) {
				if revokeErr := i.repos.Sessions.RevokeAllForUser(ctx, user.ID, now); revokeErr != nil {
					return nil, revokeErr
				}
			}
			return nil, err
		}
	}

	access, accessExpiresAt, err := i.tokens.IssueAccess(user.ID, membership.Organization.ID)
	if err != nil {
		return nil, err
	}

	return &Session{
		User:                  user,
		Organization:          membership.Organization,
		Role:                  membership.Role,
		AccessToken:           access,
		AccessExpiresAt:       accessExpiresAt,
		RefreshToken:          secret,
		RefreshExpiresAt:      refresh.ExpiresAt,
		MFAEnrollmentRequired: domain.AdminsMustHaveTOTP(membership.Role) && !user.HasTOTP(),
	}, nil
}

// Refresh exchanges a refresh secret for a new session and invalidates the old
// one.
//
// Presenting a secret that was already exchanged means two parties hold it,
// and there is no way to tell the legitimate owner from a thief. The only safe
// response is to end every session of that account.
func (i *Identity) Refresh(ctx context.Context, secret string) (*Session, error) {
	now := i.now().UTC()

	stored, err := i.repos.Sessions.ByHash(ctx, token.HashSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("refresh: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}

	if stored.IsConsumed() {
		if err := i.repos.Sessions.RevokeAllForUser(ctx, stored.UserID, now); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("refresh: %w", domain.ErrSessionReused)
	}
	if !stored.IsUsable(now) {
		return nil, fmt.Errorf("refresh: %w", domain.ErrSessionExpired)
	}

	user, err := i.repos.Users.ByID(ctx, stored.UserID)
	if err != nil {
		return nil, err
	}
	// The membership is read again rather than trusted from the old token: a
	// role changed, or a member removed, must take effect at the next refresh
	// rather than at the end of a thirty-day chain.
	membership, err := i.membershipOf(ctx, stored.OrganizationID, user.ID)
	if err != nil {
		return nil, err
	}
	return i.startSession(ctx, user, membership, stored)
}

// SwitchOrganization moves a session to another office the same account
// belongs to, by rotating the refresh token into it. The old pair stops
// working, so the browser holds one session at a time.
func (i *Identity) SwitchOrganization(ctx context.Context, secret string, organizationID uuid.UUID) (*Session, error) {
	now := i.now().UTC()

	stored, err := i.repos.Sessions.ByHash(ctx, token.HashSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("switch organization: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if !stored.IsUsable(now) {
		return nil, fmt.Errorf("switch organization: %w", domain.ErrSessionExpired)
	}

	user, err := i.repos.Users.ByID(ctx, stored.UserID)
	if err != nil {
		return nil, err
	}
	membership, err := i.membershipOf(ctx, organizationID, user.ID)
	if err != nil {
		return nil, err
	}
	return i.startSession(ctx, user, membership, stored)
}

// SignOut revokes the session a refresh secret belongs to.
//
// An unknown secret is not an error: the caller wanted the session gone, and
// it is. Reporting otherwise would turn signing out into an oracle for
// guessing valid secrets.
func (i *Identity) SignOut(ctx context.Context, secret string) error {
	stored, err := i.repos.Sessions.ByHash(ctx, token.HashSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return i.repos.Sessions.Revoke(ctx, stored.ID, i.now().UTC())
}

// Caller is who a request belongs to: the account, the office it is working
// in, and what it may do there.
type Caller struct {
	User         *domain.User
	Organization *domain.Organization
	Role         domain.Role
	// MFAEnrollmentRequired repeats what the session was told: an
	// administrator without a second factor may only enrol one.
	MFAEnrollmentRequired bool
}

// IsAdmin reports whether the caller may manage the organisation.
func (c *Caller) IsAdmin() bool { return c.Role == domain.RoleAdmin }

// Authenticate resolves the account and the membership behind an access token.
//
// The membership is read on every request rather than trusted from the token.
// A role changed a minute ago, or a member removed, has to take effect now,
// not when the token expires.
func (i *Identity) Authenticate(ctx context.Context, access token.Access) (*Caller, error) {
	user, err := i.repos.Users.ByID(ctx, access.UserID)
	if errors.Is(err, domain.ErrNotFound) {
		// The token is well formed but the account is gone.
		return nil, fmt.Errorf("authenticate: %w", token.ErrInvalidToken)
	}
	if err != nil {
		return nil, err
	}

	// An access token is stateless, so revoking a session does not reach one
	// already in circulation. Comparing against the last password change is
	// what closes that window.
	//
	// Truncated to the second because that is all a JWT issue time carries: an
	// unrounded comparison would reject the very token minted to replace the
	// session, whose iat rounds down below the instant of the change.
	if user.PasswordChangedAt != nil && access.IssuedAt.Before(user.PasswordChangedAt.Truncate(time.Second)) {
		return nil, fmt.Errorf("authenticate: %w", token.ErrInvalidToken)
	}

	membership, err := i.membershipOf(ctx, access.OrganizationID, user.ID)
	if err != nil {
		return nil, err
	}
	return &Caller{
		User:                  user,
		Organization:          membership.Organization,
		Role:                  membership.Role,
		MFAEnrollmentRequired: domain.AdminsMustHaveTOTP(membership.Role) && !user.HasTOTP(),
	}, nil
}

// membershipOf reads one membership with its organisation, reporting a
// permission failure when the account does not belong to it.
func (i *Identity) membershipOf(ctx context.Context, organizationID, userID uuid.UUID) (MembershipWithOrganization, error) {
	membership, err := i.repos.Memberships.Get(ctx, organizationID, userID)
	if errors.Is(err, domain.ErrNotFound) {
		return MembershipWithOrganization{}, fmt.Errorf("membership: %w", domain.ErrPermissionDenied)
	}
	if err != nil {
		return MembershipWithOrganization{}, err
	}
	organization, err := i.repos.Organizations.ByID(ctx, organizationID)
	if err != nil {
		return MembershipWithOrganization{}, err
	}
	return MembershipWithOrganization{Organization: organization, Role: membership.Role}, nil
}

// Organizations lists the offices an account belongs to.
func (i *Identity) Organizations(ctx context.Context, userID uuid.UUID) ([]MembershipWithOrganization, error) {
	return i.repos.Memberships.ForUser(ctx, userID)
}

// PurgeExpired removes the credentials nobody can use any more and the access
// records past their six months. It runs on a timer, not on a request.
func (i *Identity) PurgeExpired(ctx context.Context) error {
	now := i.now().UTC()

	sessions, err := i.repos.Sessions.DeleteExpired(ctx, now)
	if err != nil {
		return err
	}
	resets, err := i.repos.Resets.DeleteExpired(ctx, now)
	if err != nil {
		return err
	}
	records, err := i.repos.Audit.PurgeAccessRecords(ctx, now.Add(-domain.AccessRecordRetention))
	if err != nil {
		return err
	}
	// A closed account is kept only to name its access records, so it goes
	// once they have.
	closed, err := i.repos.Audit.PurgeClosedAccounts(ctx, now.Add(-domain.AccessRecordRetention))
	if err != nil {
		return err
	}
	if sessions+resets+records+closed > 0 {
		i.logger.Info("purged expired records",
			slog.Int64("sessions", sessions),
			slog.Int64("password_resets", resets),
			slog.Int64("access_records", records),
			slog.Int64("closed_accounts", closed),
		)
	}
	return nil
}
