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

// Organizations implements the office itself: its members, and the invitations
// that bring new ones in.
type Organizations struct {
	identity      *Identity
	repos         Repositories
	hasher        PasswordHasher
	mailer        Mailer
	sealer        Sealer
	appURL        string
	invitationTTL time.Duration
	now           Clock
	logger        *slog.Logger
	audit         *Auditor
}

// OrganizationsConfig collects the dependencies.
type OrganizationsConfig struct {
	Identity     *Identity
	Repositories Repositories
	Hasher       PasswordHasher
	Mailer       Mailer
	// Sealer seals the administrator's document, a CPF for a self-employed
	// broker.
	Sealer        Sealer
	AppURL        string
	InvitationTTL time.Duration
	Now           Clock
	Logger        *slog.Logger
}

// NewOrganizations wires the use case.
func NewOrganizations(cfg OrganizationsConfig) *Organizations {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.InvitationTTL == 0 {
		cfg.InvitationTTL = 7 * 24 * time.Hour
	}
	return &Organizations{
		identity:      cfg.Identity,
		repos:         cfg.Repositories,
		hasher:        cfg.Hasher,
		mailer:        cfg.Mailer,
		sealer:        cfg.Sealer,
		appURL:        cfg.AppURL,
		invitationTTL: cfg.InvitationTTL,
		now:           cfg.Now,
		logger:        cfg.Logger,
		audit:         NewAuditor(cfg.Repositories.Audit, cfg.Now, cfg.Logger),
	}
}

// Rename changes the office's name. Only an administrator may.
func (o *Organizations) Rename(ctx context.Context, caller *Caller, name string) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("rename organization: %w", domain.ErrPermissionDenied)
	}
	v := &domain.ValidationError{}
	domain.ValidateOrganizationName(v, "name", name)
	if err := v.OrNil(); err != nil {
		return err
	}

	now := o.now().UTC()
	return o.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.Organizations.Rename(ctx, caller.Organization.ID, name, now); err != nil {
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionOrganizationCreated,
			EntityType:     "organization",
			EntityID:       &caller.Organization.ID,
			Fields:         []string{"name"},
		})
	})
}

// Administrator reads who administers the office, for the receipts. Nil
// when the office has not said yet. Every member may read it: it is printed on
// what they hand to owners.
func (o *Organizations) Administrator(ctx context.Context, caller *Caller) (*domain.Administrator, error) {
	stored, err := o.repos.Organizations.Administrator(ctx, caller.Organization.ID)
	if err != nil || stored == nil {
		return nil, err
	}
	a := &domain.Administrator{Kind: stored.Kind, CRECI: stored.CRECI}
	if len(stored.DocumentSealed) > 0 {
		plain, err := o.sealer.Open(stored.DocumentSealed, "organizations", "administrator_document", caller.Organization.ID)
		if err != nil {
			return nil, fmt.Errorf("administrator: %w", err)
		}
		a.Document = string(plain)
	}
	return a, nil
}

// SetAdministrator records who administers the office. Administrators only.
func (o *Organizations) SetAdministrator(ctx context.Context, caller *Caller, a *domain.Administrator) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("set administrator: %w", domain.ErrPermissionDenied)
	}
	if err := domain.NormalizeAdministrator(a); err != nil {
		return err
	}
	sealed, err := o.sealer.Seal([]byte(a.Document), "organizations", "administrator_document", caller.Organization.ID)
	if err != nil {
		return fmt.Errorf("set administrator: %w", err)
	}
	now := o.now().UTC()
	return o.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.Organizations.SetAdministrator(ctx, caller.Organization.ID,
			&StoredAdministrator{Kind: a.Kind, DocumentSealed: sealed, CRECI: a.CRECI}, now); err != nil {
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionAdministratorUpdated,
			EntityType:     "organization",
			EntityID:       &caller.Organization.ID,
			Fields:         []string{"administrator_kind", "administrator_document", "administrator_creci"},
		})
	})
}

// Members lists who works in the office. Every member may see the list: they
// work together, and a list of colleagues is not a secret from them.
func (o *Organizations) Members(ctx context.Context, caller *Caller) ([]Member, error) {
	return o.repos.Memberships.Members(ctx, caller.Organization.ID)
}

// ChangeRole promotes or demotes a member.
//
// The last administrator cannot be demoted. The count and the update happen in
// one transaction, so two admins demoting each other at the same time cannot
// leave the office with none.
func (o *Organizations) ChangeRole(ctx context.Context, caller *Caller, userID uuid.UUID, role domain.Role) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("change role: %w", domain.ErrPermissionDenied)
	}
	v := &domain.ValidationError{}
	domain.ValidateRole(v, "role", role)
	if err := v.OrNil(); err != nil {
		return err
	}

	now := o.now().UTC()
	return o.identity.tx.InTx(ctx, func(repos Repositories) error {
		current, err := repos.Memberships.Get(ctx, caller.Organization.ID, userID)
		if err != nil {
			return err
		}
		if current.Role == role {
			return nil
		}
		if current.Role == domain.RoleAdmin {
			if err := o.requireAnotherAdmin(ctx, repos, caller.Organization.ID); err != nil {
				return err
			}
		}
		if err := repos.Memberships.UpdateRole(ctx, caller.Organization.ID, userID, role, now); err != nil {
			return err
		}
		// A promotion or demotion changes what the sessions already open may
		// do. Authenticate reads the membership on every request, so they
		// follow the new role immediately, and nothing has to be revoked.
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionMemberRoleChanged,
			EntityType:     "membership",
			EntityID:       &userID,
			Fields:         []string{"role"},
		})
	})
}

// RemoveMember takes someone out of the office and ends their sessions.
func (o *Organizations) RemoveMember(ctx context.Context, caller *Caller, userID uuid.UUID) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("remove member: %w", domain.ErrPermissionDenied)
	}
	if userID == caller.User.ID {
		// Removing yourself would be the quickest way to leave an office with
		// no administrator, and it reads as an accident more often than as an
		// intention.
		return fmt.Errorf("remove member: %w", domain.ErrConflict)
	}

	now := o.now().UTC()
	return o.identity.tx.InTx(ctx, func(repos Repositories) error {
		current, err := repos.Memberships.Get(ctx, caller.Organization.ID, userID)
		if err != nil {
			return err
		}
		if current.Role == domain.RoleAdmin {
			if err := o.requireAnotherAdmin(ctx, repos, caller.Organization.ID); err != nil {
				return err
			}
		}
		if err := repos.Memberships.Delete(ctx, caller.Organization.ID, userID); err != nil {
			return err
		}
		// The account may belong to another office, so it is the sessions that
		// end, not the account. Refresh reads the membership again and stops
		// there; the access token still in the browser dies with its fifteen
		// minutes.
		if err := repos.Sessions.RevokeAllForUser(ctx, userID, now); err != nil {
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionMemberRemoved,
			EntityType:     "membership",
			EntityID:       &userID,
		})
	})
}

// requireAnotherAdmin refuses a change that would leave the office with no
// administrator.
func (o *Organizations) requireAnotherAdmin(ctx context.Context, repos Repositories, organizationID uuid.UUID) error {
	admins, err := repos.Memberships.CountAdmins(ctx, organizationID)
	if err != nil {
		return err
	}
	if admins <= 1 {
		v := &domain.ValidationError{}
		v.Add("role", "the organisation would be left without an administrator")
		return v
	}
	return nil
}

// Invite asks someone to join the office.
//
// The link carries a secret, and only its digest is stored. Inviting an
// address that already has a pending invitation is answered with a conflict
// rather than a second link, so the first one's fate stays clear.
func (o *Organizations) Invite(ctx context.Context, caller *Caller, email string, role domain.Role) (*domain.Invitation, error) {
	if !caller.IsAdmin() {
		return nil, fmt.Errorf("invite: %w", domain.ErrPermissionDenied)
	}
	email = domain.NormalizeEmail(email)
	if err := domain.ValidateInvitation(email, role); err != nil {
		return nil, err
	}

	// Someone who already works here does not need an invitation, and saying
	// so to an administrator of their own office reveals nothing.
	if existing, err := o.repos.Users.ByEmail(ctx, email); err == nil {
		if _, err := o.repos.Memberships.Get(ctx, caller.Organization.ID, existing.ID); err == nil {
			v := &domain.ValidationError{}
			v.Add("email", "already belongs to this organisation")
			return nil, v
		} else if !errors.Is(err, domain.ErrNotFound) {
			return nil, err
		}
	} else if !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}

	secret, err := token.NewSecret()
	if err != nil {
		return nil, err
	}
	now := o.now().UTC()
	invitation := &domain.Invitation{
		ID:             uuid.NewV7(),
		OrganizationID: caller.Organization.ID,
		Email:          email,
		Role:           role,
		TokenHash:      token.HashSecret(secret),
		InvitedBy:      caller.User.ID,
		ExpiresAt:      now.Add(o.invitationTTL),
		CreatedAt:      now,
	}

	err = o.identity.tx.InTx(ctx, func(repos Repositories) error {
		if err := repos.Invitations.Create(ctx, invitation); err != nil {
			if errors.Is(err, domain.ErrAlreadyExists) {
				v := &domain.ValidationError{}
				v.Add("email", "already has an invitation waiting")
				return v
			}
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionInvitationSent,
			EntityType:     "invitation",
			EntityID:       &invitation.ID,
		})
	})
	if err != nil {
		return nil, err
	}

	if o.mailer != nil {
		link := o.appURL + "/convite?token=" + url.QueryEscape(secret)
		if err := o.mailer.Send(ctx, email,
			"Convite para o "+caller.Organization.Name+" no Imobiliary",
			invitationMessage(caller.User.Name, caller.Organization.Name, link, int(o.invitationTTL.Hours()/24)),
		); err != nil {
			// The invitation exists; the message did not go. An administrator
			// can revoke it and invite again, which is better than pretending
			// the invitation was never made.
			o.logger.Error("could not send an invitation", slog.Any("error", err))
		}
	}
	return invitation, nil
}

// Invitations lists what an office has outstanding.
func (o *Organizations) Invitations(ctx context.Context, caller *Caller) ([]*domain.Invitation, error) {
	if !caller.IsAdmin() {
		return nil, fmt.Errorf("invitations: %w", domain.ErrPermissionDenied)
	}
	return o.repos.Invitations.ForOrganization(ctx, caller.Organization.ID)
}

// RevokeInvitation cancels one that has not been accepted.
func (o *Organizations) RevokeInvitation(ctx context.Context, caller *Caller, id uuid.UUID) error {
	if !caller.IsAdmin() {
		return fmt.Errorf("revoke invitation: %w", domain.ErrPermissionDenied)
	}

	now := o.now().UTC()
	return o.identity.tx.InTx(ctx, func(repos Repositories) error {
		// Read within the organisation, so an administrator of one office
		// cannot revoke another's by guessing an identifier.
		invitation, err := repos.Invitations.ByID(ctx, caller.Organization.ID, id)
		if err != nil {
			return err
		}
		if err := repos.Invitations.Revoke(ctx, invitation.ID, now); err != nil {
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionInvitationRevoked,
			EntityType:     "invitation",
			EntityID:       &invitation.ID,
		})
	})
}

// PendingInvitation is what the acceptance screen shows before anyone types a
// password: which office, and for which address.
type PendingInvitation struct {
	Organization *domain.Organization
	Email        string
	Role         domain.Role
	// AccountExists tells the screen whether to ask for a password or only for
	// a confirmation.
	AccountExists bool
}

// Invitation reads one by its secret, for the screen that shows it.
func (o *Organizations) Invitation(ctx context.Context, secret string) (*PendingInvitation, error) {
	invitation, err := o.repos.Invitations.ByHash(ctx, token.HashSecret(secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("invitation: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if !invitation.IsUsable(o.now().UTC()) {
		return nil, fmt.Errorf("invitation: %w", domain.ErrInvalidCredentials)
	}

	organization, err := o.repos.Organizations.ByID(ctx, invitation.OrganizationID)
	if err != nil {
		return nil, err
	}
	_, err = o.repos.Users.ByEmail(ctx, invitation.Email)
	switch {
	case err == nil:
		return &PendingInvitation{Organization: organization, Email: invitation.Email, Role: invitation.Role, AccountExists: true}, nil
	case errors.Is(err, domain.ErrNotFound):
		return &PendingInvitation{Organization: organization, Email: invitation.Email, Role: invitation.Role}, nil
	default:
		return nil, err
	}
}

// Acceptance is what someone joining types: a name and a password when the
// account is new, or nothing at all when it already exists.
type Acceptance struct {
	Secret       string
	Name         string
	Password     string
	TermsVersion string
}

// Accept joins the office, creating the account when there is none.
//
// The account, the membership and the acceptance are one transaction: a
// membership without an account, or an invitation marked accepted by someone
// who never got in, are both states nothing could explain afterwards.
func (o *Organizations) Accept(ctx context.Context, a Acceptance) (*domain.User, error) {
	now := o.now().UTC()

	invitation, err := o.repos.Invitations.ByHash(ctx, token.HashSecret(a.Secret))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("accept invitation: %w", domain.ErrInvalidCredentials)
	}
	if err != nil {
		return nil, err
	}
	if !invitation.IsUsable(now) {
		return nil, fmt.Errorf("accept invitation: %w", domain.ErrInvalidCredentials)
	}

	user, err := o.repos.Users.ByEmail(ctx, invitation.Email)
	switch {
	case err == nil:
		// The account exists: joining costs no password. Whoever opened the
		// link had it in their inbox, and the account's own password still
		// guards signing in.
	case errors.Is(err, domain.ErrNotFound):
		v := &domain.ValidationError{}
		domain.ValidateName(v, "name", a.Name)
		domain.ValidatePassword(v, "password", a.Password)
		if a.TermsVersion == "" {
			v.Add("terms_version", "is required")
		}
		if err := v.OrNil(); err != nil {
			return nil, err
		}
		hash, hashErr := o.hasher.Hash(a.Password)
		if hashErr != nil {
			return nil, fmt.Errorf("accept invitation: hash: %w", hashErr)
		}
		user = &domain.User{
			ID:              uuid.NewV7(),
			Email:           invitation.Email,
			Name:            a.Name,
			PasswordHash:    hash,
			CreatedAt:       now,
			UpdatedAt:       now,
			TermsAcceptedAt: &now,
			TermsVersion:    a.TermsVersion,
		}
	default:
		return nil, err
	}

	created := user.CreatedAt.Equal(now)
	err = o.identity.tx.InTx(ctx, func(repos Repositories) error {
		// Accepting is a conditional update, so a link opened twice joins
		// once.
		if err := repos.Invitations.Accept(ctx, invitation.ID, now); err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return fmt.Errorf("accept invitation: %w", domain.ErrInvalidCredentials)
			}
			return err
		}
		if created {
			if err := repos.Users.Create(ctx, user); err != nil {
				return err
			}
		}
		membership := &domain.Membership{
			OrganizationID: invitation.OrganizationID,
			UserID:         user.ID,
			Role:           invitation.Role,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if err := repos.Memberships.Create(ctx, membership); err != nil && !errors.Is(err, domain.ErrAlreadyExists) {
			return err
		}
		return o.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &invitation.OrganizationID,
			ActorID:        &user.ID,
			Action:         domain.ActionInvitationAccepted,
			EntityType:     "invitation",
			EntityID:       &invitation.ID,
		})
	})
	if err != nil {
		return nil, err
	}
	return user, nil
}
