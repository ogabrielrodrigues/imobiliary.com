package usecase

import (
	"context"
	"fmt"
	"slices"
	"uuid"

	"imobiliary/internal/domain"
)

// AmendmentInput is what the office types to adjust a rent. IndexedRent nil
// takes the suggestion.
type AmendmentInput struct {
	AmendedOn   domain.Date
	IndexRate   domain.Rate
	IndexedRent *domain.Money
}

// AmendmentPreview is what an adjustment would do, before it is recorded.
type AmendmentPreview struct {
	Amendment     *domain.Amendment
	SuggestedRent domain.Money
	// FirstSequence is the first instalment the new rent reaches, and
	// AffectedRents how many unpaid instalments it changes.
	FirstSequence int
	AffectedRents int
	FirstDueOn    *domain.Date
	Notices       []domain.NoticeCode
}

type preparedAmendment struct {
	contract *domain.Contract
	preview  *AmendmentPreview
}

func (c *Contracts) prepareAmendment(ctx context.Context, repos ScopedRepositories, contractID uuid.UUID, in AmendmentInput) (*preparedAmendment, error) {
	contract, _, rents, err := repos.Contracts.Get(ctx, contractID)
	if err != nil {
		return nil, err
	}
	list, err := repos.Amendments.List(ctx, contractID)
	if err != nil {
		return nil, err
	}
	var last *domain.Amendment
	if len(list) > 0 {
		last = &list[len(list)-1]
	}

	suggested, err := domain.SuggestedRent(contract.CurrentRent, in.IndexRate)
	if err != nil {
		v := &domain.ValidationError{}
		v.Add("index_rate", "makes a rent out of range")
		return nil, v
	}
	a := &domain.Amendment{
		ID: uuid.NewV7(), ContractID: contractID, AmendedOn: in.AmendedOn, Index: contract.AdjustmentIndex,
		IndexRate: in.IndexRate, PreviousRent: contract.CurrentRent, IndexedRent: suggested,
	}
	if in.IndexedRent != nil {
		a.IndexedRent = *in.IndexedRent
	}
	if err := domain.ValidateAmendment(contract, last, a); err != nil {
		return nil, err
	}

	preview := &AmendmentPreview{
		Amendment: a, SuggestedRent: suggested,
		FirstSequence: domain.FirstAdjustedSequence(contract, a.AmendedOn),
		Notices:       domain.AmendmentNotices(contract, last, a),
	}
	stored := make([]domain.TerminationRent, len(rents))
	for i, r := range rents {
		stored[i] = domain.TerminationRent{Sequence: r.Sequence, Amount: r.Amount, Paid: r.PaidOn != nil}
		if r.Sequence >= preview.FirstSequence && r.PaidOn == nil {
			preview.AffectedRents++
			if preview.FirstDueOn == nil {
				due := r.DueOn
				preview.FirstDueOn = &due
			}
		}
	}
	if domain.PaidFrom(stored, preview.FirstSequence) {
		v := &domain.ValidationError{}
		v.Add("amended_on", "a rent from this day on is already paid")
		return nil, v
	}
	return &preparedAmendment{contract: contract, preview: preview}, nil
}

// PreviewAmendment answers what an adjustment would do, recording nothing.
func (c *Contracts) PreviewAmendment(ctx context.Context, caller *Caller, contractID uuid.UUID, in AmendmentInput) (*AmendmentPreview, error) {
	var preview *AmendmentPreview
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		prepared, err := c.prepareAmendment(ctx, repos, contractID, in)
		if err != nil {
			return err
		}
		preview = prepared.preview
		return nil
	})
	return preview, err
}

// Amend records an adjustment as of the contract's version: the contract's
// current rent and its unpaid instalments from the adjustment's month on move
// to the new rent in one transaction.
func (c *Contracts) Amend(ctx context.Context, caller *Caller, contractID uuid.UUID, version int, in AmendmentInput, acknowledged []domain.NoticeCode) (*ContractView, error) {
	if version <= 0 {
		return nil, fmt.Errorf("amend contract: %w", domain.ErrPreconditionRequired)
	}
	now := c.now().UTC()
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		prepared, err := c.prepareAmendment(ctx, repos, contractID, in)
		if err != nil {
			return err
		}
		if prepared.contract.Version != version {
			return fmt.Errorf("amend contract: %w", domain.ErrPreconditionFailed)
		}
		preview := prepared.preview
		if err := domain.MissingAcknowledgements(preview.Notices, acknowledged); err != nil {
			return err
		}
		a := preview.Amendment
		a.CreatedAt = now
		if slices.Contains(preview.Notices, domain.NoticeAdjustmentPeriod) {
			a.PeriodAcknowledgedBy, a.PeriodAcknowledgedAt = &caller.User.ID, &now
		}
		if err := repos.Amendments.Create(ctx, a, version, preview.FirstSequence); err != nil {
			return err
		}
		for _, code := range preview.Notices {
			if err := c.audit.recordWith(ctx, repos.Audit, AuditEntry{
				OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
				Action: domain.ActionNoticeAcknowledged, EntityType: "contract", EntityID: &contractID,
				Fields: []string{string(code)},
			}); err != nil {
				return err
			}
		}
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionContractAmended, EntityType: "contract", EntityID: &contractID,
			Fields: []string{"current_rent"},
		})
	})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, caller, contractID)
}

// UndoAmendment removes the last adjustment and puts its previous rent back,
// for a typing mistake. Only the last one, only while the contract runs, and
// only while no instalment it reached was paid.
func (c *Contracts) UndoAmendment(ctx context.Context, caller *Caller, contractID, amendmentID uuid.UUID, version int) (*ContractView, error) {
	if version <= 0 {
		return nil, fmt.Errorf("undo amendment: %w", domain.ErrPreconditionRequired)
	}
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		contract, _, rents, err := repos.Contracts.Get(ctx, contractID)
		if err != nil {
			return err
		}
		if contract.Version != version {
			return fmt.Errorf("undo amendment: %w", domain.ErrPreconditionFailed)
		}
		list, err := repos.Amendments.List(ctx, contractID)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(list, func(a domain.Amendment) bool { return a.ID == amendmentID })
		if i < 0 {
			return fmt.Errorf("undo amendment: %w", domain.ErrNotFound)
		}
		a := &list[i]
		v := &domain.ValidationError{}
		first := domain.FirstAdjustedSequence(contract, a.AmendedOn)
		stored := make([]domain.TerminationRent, len(rents))
		for j, r := range rents {
			stored[j] = domain.TerminationRent{Sequence: r.Sequence, Amount: r.Amount, Paid: r.PaidOn != nil}
		}
		switch {
		case i != len(list)-1:
			v.Add("amendment", "only the last adjustment can be undone")
		case contract.TerminatedOn != nil:
			v.Add("amendment", "a terminated contract keeps its adjustments")
		case domain.PaidFrom(stored, first):
			v.Add("amendment", "a rent it reached is already paid")
		}
		if err := v.OrNil(); err != nil {
			return err
		}
		if err := repos.Amendments.Delete(ctx, a, version, first, c.now().UTC()); err != nil {
			return err
		}
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionAmendmentUndone, EntityType: "contract", EntityID: &contractID,
			Fields: []string{"current_rent"},
		})
	})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, caller, contractID)
}
