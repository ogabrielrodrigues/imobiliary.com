package usecase

import (
	"context"
	"fmt"
	"log/slog"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Privacy implements what the LGPD lets a person ask about their own account:
// a copy of what is held (art. 18, II) and its erasure (art. 18, VI).
//
// It covers the account, which this service controls. The people, properties
// and contracts an office registers from phase 2 onwards belong to the office,
// which is their controller; a request about those goes to the office.
type Privacy struct {
	identity *Identity
	repos    Repositories
	hasher   PasswordHasher
	sealer   Sealer
	mailer   Mailer
	now      Clock
	logger   *slog.Logger
	audit    *Auditor
}

// PrivacyConfig collects the dependencies.
type PrivacyConfig struct {
	Identity     *Identity
	Repositories Repositories
	Hasher       PasswordHasher
	// Sealer seals the address kept for a closed account.
	Sealer Sealer
	// Mailer confirms an erasure to the address that owned the account.
	Mailer Mailer
	Now    Clock
	Logger *slog.Logger
}

// NewPrivacy wires the use case.
func NewPrivacy(cfg PrivacyConfig) *Privacy {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Privacy{
		identity: cfg.Identity,
		repos:    cfg.Repositories,
		hasher:   cfg.Hasher,
		sealer:   cfg.Sealer,
		mailer:   cfg.Mailer,
		now:      cfg.Now,
		logger:   cfg.Logger,
		audit:    NewAuditor(cfg.Repositories.Audit, cfg.Now, cfg.Logger),
	}
}

// AccountExport is everything held about one account.
//
// Secrets are left out even though they are the account's own: a password
// hash, a second-factor secret and the digests of tokens and codes are not
// information about the person, and a copy of them in a downloaded file would
// only be a copy an attacker could use.
type AccountExport struct {
	ExportedAt        time.Time
	User              *domain.User
	Memberships       []MembershipWithOrganization
	RecoveryCodesLeft int
	Sessions          []*domain.RefreshToken
	Invitations       []ReceivedInvitation
	AuditEvents       []*domain.AuditEvent
	AccessRecords     []*domain.AccessRecord
}

// Export gathers the copy of an account's data.
func (p *Privacy) Export(ctx context.Context, caller *Caller) (*AccountExport, error) {
	user := caller.User
	out := &AccountExport{ExportedAt: p.now().UTC(), User: user}

	var err error
	if out.Memberships, err = p.repos.Memberships.ForUser(ctx, user.ID); err != nil {
		return nil, err
	}
	if user.HasTOTP() {
		if out.RecoveryCodesLeft, err = p.repos.MFA.CountUnusedRecoveryCodes(ctx, user.ID); err != nil {
			return nil, err
		}
	}
	if out.Sessions, err = p.repos.Sessions.ForUser(ctx, user.ID); err != nil {
		return nil, err
	}
	if out.Invitations, err = p.repos.Invitations.ForEmail(ctx, user.Email); err != nil {
		return nil, err
	}
	if out.AuditEvents, err = p.repos.Audit.EventsByActor(ctx, user.ID); err != nil {
		return nil, err
	}
	if out.AccessRecords, err = p.repos.Audit.AccessRecordsForUser(ctx, user.ID); err != nil {
		return nil, err
	}

	// Recorded after reading, so a failed export leaves no claim that one was
	// handed over, and the next export shows this one.
	if err := p.audit.Record(ctx, AuditEntry{
		OrganizationID: &caller.Organization.ID,
		ActorID:        &user.ID,
		Action:         domain.ActionDataExported,
		EntityType:     "user",
		EntityID:       &user.ID,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// closedAccountsTable and closedEmailColumn name where the kept address is
// sealed, so a ciphertext moved to another row cannot be opened.
const (
	closedAccountsTable = "closed_accounts"
	closedEmailColumn   = "email"
)

// DeleteAccount erases an account, asked for by its owner with their password.
//
// What goes: the account, its memberships, sessions, second factor, recovery
// codes and pending resets, all by cascade. An office whose only member is
// this account goes with it, since nobody else could ever reach it.
//
// What stays, and why:
//   - the audit trail, without the actor (the foreign key sets it null). An
//     office's record of what was done does not belong to the person who did
//     it, and erasing it would erase the office's evidence;
//   - the access records, with the account's identifier, and the address
//     that identified the account, sealed, in closed_accounts. The Marco Civil
//     (art. 15) obliges six months of records; the LGPD (art. 16, I) allows
//     keeping data to meet a legal obligation. Both go after six months.
//
// An administrator who is the only one in an office with other members is
// refused: deleting the account would leave those members in an office nobody
// can manage. Making someone else an administrator first resolves it.
func (p *Privacy) DeleteAccount(ctx context.Context, caller *Caller, password string) error {
	if password == "" {
		v := &domain.ValidationError{}
		v.Add("password", "is required")
		return v
	}
	user := caller.User
	if err := p.hasher.Verify(password, user.PasswordHash); err != nil {
		return fmt.Errorf("delete account: %w", domain.ErrInvalidCredentials)
	}

	now := p.now().UTC()
	sealedEmail, err := p.sealer.Seal([]byte(user.Email), closedAccountsTable, closedEmailColumn, user.ID)
	if err != nil {
		return fmt.Errorf("delete account: seal address: %w", err)
	}

	err = p.identity.tx.InTx(ctx, func(repos Repositories) error {
		memberships, err := repos.Memberships.ForUser(ctx, user.ID)
		if err != nil {
			return err
		}

		v := &domain.ValidationError{}
		var closing []uuid.UUID
		for _, m := range memberships {
			if m.Role != domain.RoleAdmin {
				continue
			}
			members, err := repos.Memberships.CountMembers(ctx, m.Organization.ID)
			if err != nil {
				return err
			}
			if members == 1 {
				closing = append(closing, m.Organization.ID)
				continue
			}
			admins, err := repos.Memberships.CountAdmins(ctx, m.Organization.ID)
			if err != nil {
				return err
			}
			if admins <= 1 {
				v.Addf("organizations", "is the only administrator of %q, which has other members", m.Organization.Name)
			}
		}
		if err := v.OrNil(); err != nil {
			return err
		}

		// Written before the account goes, while the actor still exists. Each
		// office the person belonged to gets its own entry, so its trail says
		// the member left; an office being closed loses the reference with the
		// row, which is right, since nobody is left to read it.
		entries := make([]AuditEntry, 0, max(len(memberships), 1))
		for _, m := range memberships {
			entries = append(entries, AuditEntry{
				OrganizationID: &m.Organization.ID,
				ActorID:        &user.ID,
				Action:         domain.ActionAccountDeleted,
				EntityType:     "user",
				EntityID:       &user.ID,
			})
		}
		if len(entries) == 0 {
			entries = append(entries, AuditEntry{
				ActorID: &user.ID, Action: domain.ActionAccountDeleted, EntityType: "user", EntityID: &user.ID,
			})
		}
		for _, entry := range entries {
			if err := p.audit.recordWith(ctx, repos.Audit, entry); err != nil {
				return err
			}
		}

		for _, id := range closing {
			if err := repos.Organizations.Delete(ctx, id); err != nil {
				return err
			}
		}
		if err := repos.Audit.RecordClosedAccount(ctx, user.ID, sealedEmail, now); err != nil {
			return err
		}
		return repos.Users.Delete(ctx, user.ID)
	})
	if err != nil {
		return err
	}

	p.audit.Access(ctx, &user.ID, domain.AccessAccountClosed)

	// Told afterwards, to the address that owned the account: an erasure
	// nobody asked for is what a stolen session does last.
	if p.mailer != nil {
		if err := p.mailer.Send(ctx, user.Email, "Sua conta no Imobiliary foi excluída",
			accountDeletedMessage(user.Name)); err != nil {
			p.logger.Error("could not send the deletion notice", slog.Any("error", err))
		}
	}
	return nil
}
