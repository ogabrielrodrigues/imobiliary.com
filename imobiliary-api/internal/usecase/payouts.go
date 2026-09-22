package usecase

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Payouts implements the owners' side of the money (PLANO-REPASSE.md): who is
// owed what, the manual lines the office types, and the payouts it records
// once it transferred. The platform never moves money itself.
type Payouts struct {
	scope    OrganizationScope
	now      Clock
	location *time.Location
	logger   *slog.Logger
	audit    *Auditor
}

// PayoutsConfig collects the dependencies.
type PayoutsConfig struct {
	Scope    OrganizationScope
	Now      Clock
	Location *time.Location
	Logger   *slog.Logger
}

// NewPayouts wires the use case.
func NewPayouts(cfg PayoutsConfig) *Payouts {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &Payouts{
		scope: cfg.Scope, now: cfg.Now, location: cfg.Location, logger: cfg.Logger,
		audit: &Auditor{now: cfg.Now, logger: cfg.Logger},
	}
}

// Today is the current calendar day where the offices are.
func (u *Payouts) Today() domain.Date { return domain.DateOf(u.now(), u.location) }

// Balances is everyone with lines waiting for a payout, the oldest first.
func (u *Payouts) Balances(ctx context.Context, caller *Caller) ([]Balance, error) {
	var out []Balance
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		out, err = repos.Ledger.Balances(ctx)
		return err
	})
	return out, err
}

// PersonLedger is one beneficiary's pending lines and their sum.
type PersonLedger struct {
	Person  PersonLink
	Pending []EntryView
	Balance int64
	Today   domain.Date
}

func person(ctx context.Context, repos ScopedRepositories, id uuid.UUID) (PersonLink, error) {
	links, err := repos.People.Links(ctx, []uuid.UUID{id})
	if err != nil {
		return PersonLink{}, err
	}
	link, ok := links[id]
	if !ok {
		return PersonLink{}, fmt.Errorf("person: %w", domain.ErrNotFound)
	}
	return link, nil
}

// Ledger reads a person's pending lines. A person with none has an empty
// ledger, not an error: nothing is owed.
func (u *Payouts) Ledger(ctx context.Context, caller *Caller, personID uuid.UUID) (*PersonLedger, error) {
	out := &PersonLedger{Today: u.Today()}
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		if out.Person, err = person(ctx, repos, personID); err != nil {
			return err
		}
		if out.Pending, err = repos.Ledger.Pending(ctx, personID); err != nil {
			return err
		}
		for i := range out.Pending {
			out.Balance += out.Pending[i].Signed()
		}
		return nil
	})
	return out, err
}

// AddEntry records a debit or credit the office typed.
func (u *Payouts) AddEntry(ctx context.Context, caller *Caller, personID uuid.UUID, e *domain.LedgerEntry) (*domain.LedgerEntry, error) {
	domain.NormalizeEntry(e)
	if err := domain.ValidateManualEntry(e, u.Today()); err != nil {
		return nil, err
	}
	e.ID, e.PersonID, e.CreatedBy, e.CreatedAt = uuid.NewV7(), personID, &caller.User.ID, u.now().UTC()
	e.RentID, e.ContractID, e.ChargeID, e.PayoutID = nil, nil, nil, nil
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if _, err := person(ctx, repos, personID); err != nil {
			return err
		}
		if e.PropertyID != nil {
			if _, _, err := repos.Properties.Get(ctx, *e.PropertyID); errors.Is(err, domain.ErrNotFound) {
				v := &domain.ValidationError{}
				v.Add("property_id", "names a property that does not exist")
				return v
			} else if err != nil {
				return err
			}
		}
		if err := repos.Ledger.Insert(ctx, []domain.LedgerEntry{*e}); err != nil {
			return err
		}
		return u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionLedgerEntryCreated, EntityType: "person", EntityID: &personID,
			Fields: []string{string(e.Kind)},
		})
	})
	if err != nil {
		return nil, err
	}
	return e, nil
}

// DeleteEntry removes a manual line still pending. A line a rent wrote goes
// only with its payment's reversal, and one in a payout only after the payout
// is undone.
func (u *Payouts) DeleteEntry(ctx context.Context, caller *Caller, id uuid.UUID) error {
	return u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		e, err := repos.Ledger.Entry(ctx, id)
		if err != nil {
			return err
		}
		v := &domain.ValidationError{}
		switch {
		case !e.Kind.IsManual():
			v.Add("entry", "comes from a rent; reverse the rent's payment instead")
		case e.PayoutID != nil:
			v.Add("entry", "is in a payout; undo the payout first")
		}
		if err := v.OrNil(); err != nil {
			return err
		}
		if err := repos.Ledger.DeleteEntry(ctx, id); err != nil {
			return err
		}
		return u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionLedgerEntryDeleted, EntityType: "person", EntityID: &e.PersonID,
			Fields: []string{string(e.Kind)},
		})
	})
}

// PayoutInput is a payout as the office records it.
type PayoutInput struct {
	PersonID uuid.UUID
	PaidOn   domain.Date
	EntryIDs []uuid.UUID
	Method   domain.PayoutMethod
	Note     string
}

// PayoutDetail is a payout with every line it closed: the statement.
type PayoutDetail struct {
	Payout  PayoutSummary
	Person  PersonLink
	Entries []EntryView
}

// MaxPayoutLines bounds one payout, which is still a year of rents for
// several properties.
const MaxPayoutLines = 2000

// Create records a payout over the named lines. They must all be the
// person's and pending; a line another payout took meanwhile is a conflict.
func (u *Payouts) Create(ctx context.Context, caller *Caller, in PayoutInput) (*PayoutDetail, error) {
	p := &domain.Payout{
		ID: uuid.NewV7(), PersonID: in.PersonID, PaidOn: in.PaidOn, Method: in.Method, Note: in.Note,
		CreatedBy: &caller.User.ID, CreatedAt: u.now().UTC(),
	}
	domain.NormalizePayout(p)
	ids := slices.Clone(in.EntryIDs)
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	ids = slices.Compact(ids)
	if len(ids) > MaxPayoutLines {
		v := &domain.ValidationError{}
		v.Addf("entry_ids", "must be at most %d", MaxPayoutLines)
		return nil, v
	}

	var out *PayoutDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		link, err := person(ctx, repos, in.PersonID)
		if err != nil {
			return err
		}
		entries, err := repos.Ledger.Entries(ctx, ids)
		if err != nil {
			return err
		}
		if len(entries) != len(ids) {
			v := &domain.ValidationError{}
			v.Add("entry_ids", "names a line that does not exist")
			return v
		}
		if err := domain.ValidatePayout(p, entries, u.Today()); err != nil {
			return err
		}
		p.Total = domain.Money(domain.PayoutTotal(entries))
		if err := repos.Ledger.CreatePayout(ctx, p, ids); err != nil {
			return err
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionPayoutCreated, EntityType: "payout", EntityID: &p.ID,
			Fields: []string{"paid_on", "total", "entries"},
		}); err != nil {
			return err
		}
		out, err = u.detail(ctx, repos, p.ID)
		if out != nil {
			out.Person = link
		}
		return err
	})
	return out, err
}

func (u *Payouts) detail(ctx context.Context, repos ScopedRepositories, id uuid.UUID) (*PayoutDetail, error) {
	summary, err := repos.Ledger.Payout(ctx, id)
	if err != nil {
		return nil, err
	}
	entries, err := repos.Ledger.PayoutEntries(ctx, id)
	if err != nil {
		return nil, err
	}
	link, err := person(ctx, repos, summary.PersonID)
	if err != nil {
		return nil, err
	}
	return &PayoutDetail{Payout: *summary, Person: link, Entries: entries}, nil
}

// Get reads a payout with its lines.
func (u *Payouts) Get(ctx context.Context, caller *Caller, id uuid.UUID) (*PayoutDetail, error) {
	var out *PayoutDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		out, err = u.detail(ctx, repos, id)
		return err
	})
	return out, err
}

const (
	defaultPayoutPage = 50
	maxPayoutPage     = 200
)

// PayoutsPage is one page of payouts, newest first.
type PayoutsPage struct {
	Payouts []PayoutSummary
	Next    *PayoutCursor
}

// List pages the payouts, optionally one person's.
func (u *Payouts) List(ctx context.Context, caller *Caller, q PayoutQuery) (*PayoutsPage, error) {
	switch {
	case q.Limit <= 0:
		q.Limit = defaultPayoutPage
	case q.Limit > maxPayoutPage:
		q.Limit = maxPayoutPage
	}
	want := q.Limit
	q.Limit++
	page := &PayoutsPage{}
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rows, err := repos.Ledger.Payouts(ctx, q)
		if err != nil {
			return err
		}
		if len(rows) > want {
			rows = rows[:want]
			last := rows[want-1]
			page.Next = &PayoutCursor{PaidOn: last.PaidOn, ID: last.ID}
		}
		page.Payouts = rows
		return nil
	})
	return page, err
}

// Undo removes a payout recorded by mistake or returned: its lines are
// pending again. The platform cannot know whether the money left; the person
// undoing it says so by doing it, and the audit trail keeps who and when.
func (u *Payouts) Undo(ctx context.Context, caller *Caller, id uuid.UUID) error {
	return u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if _, err := repos.Ledger.Payout(ctx, id); err != nil {
			return err
		}
		if err := repos.Ledger.DeletePayout(ctx, id); err != nil {
			return err
		}
		return u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionPayoutUndone, EntityType: "payout", EntityID: &id,
			Fields: []string{"paid_on", "total", "entries"},
		})
	})
}
