package usecase

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Contracts implements leases: previewing their schedule and legal notices,
// creating them with the notices acknowledged, editing, terminating and
// deleting them.
type Contracts struct {
	scope    OrganizationScope
	now      Clock
	location *time.Location
	logger   *slog.Logger
	audit    *Auditor
}

// ContractsConfig collects the dependencies.
type ContractsConfig struct {
	Scope OrganizationScope
	Now   Clock
	// Location is where "today" is reckoned, America/Sao_Paulo in production:
	// an instalment is overdue by the calendar of the office, not of the server.
	Location *time.Location
	Logger   *slog.Logger
}

// NewContracts wires the use case.
func NewContracts(cfg ContractsConfig) *Contracts {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &Contracts{
		scope:    cfg.Scope,
		now:      cfg.Now,
		location: cfg.Location,
		logger:   cfg.Logger,
		audit:    &Auditor{now: cfg.Now, logger: cfg.Logger},
	}
}

// Today is the current calendar day where the offices are.
func (c *Contracts) Today() domain.Date { return domain.DateOf(c.now(), c.location) }

// ContractPreview is what a contract would be, before it is saved.
type ContractPreview struct {
	Contract *domain.Contract
	Schedule []domain.Instalment
	Notices  []domain.NoticeCode
}

// ContractView is a stored contract with everything its screen shows.
type ContractView struct {
	Contract *domain.Contract
	Property *domain.Property
	Parties  []ContractPartyView
	Rents    []RentRecord
	Notices  []domain.NoticeCode
	// Amendments are the rent adjustments, oldest first.
	Amendments []domain.Amendment
	Today      domain.Date
}

// ContractsPage is one page of the list.
type ContractsPage struct {
	Contracts []ContractSummary
	Next      *ContractCursor
	Today     domain.Date
}

// Preview validates a contract and answers its schedule and the notices it
// raises, saving nothing. The creation screen shows both before asking for
// the acknowledgements.
func (c *Contracts) Preview(ctx context.Context, caller *Caller, contract *domain.Contract) (*ContractPreview, error) {
	var preview *ContractPreview
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		preview, err = c.prepare(ctx, repos, contract)
		return err
	})
	return preview, err
}

// prepare normalises, fills the landlords from the property's owners when
// none were named, validates, and computes the schedule and the notices.
func (c *Contracts) prepare(ctx context.Context, repos ScopedRepositories, contract *domain.Contract) (*ContractPreview, error) {
	domain.NormalizeContract(contract)
	contract.CurrentRent = contract.Rent

	if contract.PropertyID != (uuid.UUID{}) {
		property, _, err := repos.Properties.Get(ctx, contract.PropertyID)
		switch {
		case errors.Is(err, domain.ErrNotFound):
			v := &domain.ValidationError{}
			v.Add("property_id", "names a property that does not exist")
			return nil, v
		case err != nil:
			return nil, err
		}
		if !slices.ContainsFunc(contract.Parties, func(p domain.ContractParty) bool { return p.Role == domain.RoleLandlord }) {
			// The plan's default: the landlords are the property's owners.
			landlords := make([]domain.ContractParty, 0, len(property.Owners))
			for _, owner := range property.Owners {
				landlords = append(landlords, domain.ContractParty{PersonID: owner.PersonID, Role: domain.RoleLandlord})
			}
			contract.Parties = append(landlords, contract.Parties...)
		}
	}

	if err := domain.ValidateContract(contract); err != nil {
		return nil, err
	}

	ids := make([]uuid.UUID, 0, len(contract.Parties))
	for _, p := range contract.Parties {
		ids = append(ids, p.PersonID)
	}
	links, err := repos.People.Links(ctx, ids)
	if err != nil {
		return nil, err
	}
	people := make(map[uuid.UUID]domain.PartyPerson, len(links))
	v := &domain.ValidationError{}
	for i, p := range contract.Parties {
		link, found := links[p.PersonID]
		if !found {
			v.Addf(fmt.Sprintf("parties[%d].person_id", i), "names a person that does not exist")
			continue
		}
		if (p.Role == domain.RoleGuarantor || p.Role == domain.RoleGuarantorSpouse) && link.Kind != domain.PersonIndividual {
			v.Addf(fmt.Sprintf("parties[%d].person_id", i), "a guarantor must be an individual")
		}
		people[p.PersonID] = domain.PartyPerson{
			MaritalStatus: link.MaritalStatus, PropertyRegime: link.PropertyRegime, SpouseID: link.SpouseID,
		}
	}
	if err := v.OrNil(); err != nil {
		return nil, err
	}

	return &ContractPreview{
		Contract: contract,
		Schedule: domain.Schedule(contract),
		Notices:  domain.Notices(contract, people),
	}, nil
}

// Create stores a contract once every notice it raises was acknowledged.
func (c *Contracts) Create(ctx context.Context, caller *Caller, contract *domain.Contract, acknowledged []domain.NoticeCode) (*ContractView, error) {
	now := c.now().UTC()
	contract.ID = uuid.NewV7()
	contract.OrganizationID = caller.Organization.ID
	contract.CreatedAt, contract.UpdatedAt, contract.Version = now, now, 1

	var id uuid.UUID
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		preview, err := c.prepare(ctx, repos, contract)
		if err != nil {
			return err
		}
		if err := domain.MissingAcknowledgements(preview.Notices, acknowledged); err != nil {
			return err
		}
		contract.Acknowledgements = acknowledge(preview.Notices, nil, caller.User.ID, now)
		if err := repos.Contracts.Create(ctx, contract, preview.Schedule); err != nil {
			return err
		}
		if err := c.recordNotices(ctx, repos, caller, contract, nil); err != nil {
			return err
		}
		id = contract.ID
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionContractCreated, EntityType: "contract", EntityID: &contract.ID,
		})
	})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, caller, id)
}

// Update replaces a contract as of a version. Its schedule is generated again,
// which is refused once an instalment was paid: from then on the payments
// belong to the schedule they were made against.
func (c *Contracts) Update(ctx context.Context, caller *Caller, contract *domain.Contract, version int, acknowledged []domain.NoticeCode) (*ContractView, error) {
	if version <= 0 {
		return nil, fmt.Errorf("update contract: %w", domain.ErrPreconditionRequired)
	}
	now := c.now().UTC()
	contract.OrganizationID = caller.Organization.ID
	contract.UpdatedAt = now

	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		previous, _, _, err := repos.Contracts.Get(ctx, contract.ID)
		if err != nil {
			return err
		}
		if previous.Version != version {
			return fmt.Errorf("update contract: %w", domain.ErrPreconditionFailed)
		}
		if previous.TerminatedOn != nil {
			v := &domain.ValidationError{}
			v.Add("terminated_on", "a terminated contract cannot be edited")
			return v
		}
		paid, err := repos.Contracts.HasPayments(ctx, contract.ID)
		if err != nil {
			return err
		}
		if paid {
			v := &domain.ValidationError{}
			v.Add("rents", "an instalment was already paid, so the schedule cannot be generated again")
			return v
		}
		// Regenerating the schedule would put the agreed rent back over an
		// adjustment; from the first one on, rent changes go through amendments.
		if amendments, err := repos.Amendments.List(ctx, contract.ID); err != nil {
			return err
		} else if len(amendments) > 0 {
			v := &domain.ValidationError{}
			v.Add("amendments", "the rent was adjusted, so the schedule cannot be generated again")
			return v
		}

		preview, err := c.prepare(ctx, repos, contract)
		if err != nil {
			return err
		}
		// What was acknowledged before stays acknowledged; only a notice the
		// edit raises for the first time needs a new acknowledgement.
		already := make([]domain.NoticeCode, 0, len(previous.Acknowledgements))
		for _, a := range previous.Acknowledgements {
			already = append(already, a.Code)
		}
		if err := domain.MissingAcknowledgements(preview.Notices, append(already, acknowledged...)); err != nil {
			return err
		}
		contract.CreatedAt = previous.CreatedAt
		contract.Acknowledgements = acknowledge(preview.Notices, previous.Acknowledgements, caller.User.ID, now)
		if err := repos.Contracts.Replace(ctx, contract, version, preview.Schedule); err != nil {
			return err
		}
		if err := c.recordNotices(ctx, repos, caller, contract, previous.Acknowledgements); err != nil {
			return err
		}
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionContractUpdated, EntityType: "contract", EntityID: &contract.ID,
			Fields: changedContractFields(previous, contract),
		})
	})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, caller, contract.ID)
}

// acknowledge keeps the acknowledgements of the notices still raised: the ones
// given before, with their author and time, and new ones for the rest.
func acknowledge(raised []domain.NoticeCode, previous []domain.Acknowledgement, userID uuid.UUID, at time.Time) []domain.Acknowledgement {
	out := make([]domain.Acknowledgement, 0, len(raised))
	for _, code := range raised {
		if i := slices.IndexFunc(previous, func(a domain.Acknowledgement) bool { return a.Code == code }); i >= 0 {
			out = append(out, previous[i])
			continue
		}
		out = append(out, domain.Acknowledgement{Code: code, AcknowledgedBy: &userID, AcknowledgedAt: at})
	}
	return out
}

// recordNotices writes one audit entry per acknowledgement given now.
func (c *Contracts) recordNotices(ctx context.Context, repos ScopedRepositories, caller *Caller, contract *domain.Contract, previous []domain.Acknowledgement) error {
	for _, a := range contract.Acknowledgements {
		if slices.ContainsFunc(previous, func(p domain.Acknowledgement) bool { return p.Code == a.Code }) {
			continue
		}
		if err := c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionNoticeAcknowledged, EntityType: "contract", EntityID: &contract.ID,
			Fields: []string{string(a.Code)},
		}); err != nil {
			return err
		}
	}
	return nil
}

// Get reads a contract with its property, parties and instalments.
func (c *Contracts) Get(ctx context.Context, caller *Caller, id uuid.UUID) (*ContractView, error) {
	var view *ContractView
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		contract, parties, rents, err := repos.Contracts.Get(ctx, id)
		if err != nil {
			return err
		}
		property, _, err := repos.Properties.Get(ctx, contract.PropertyID)
		if err != nil {
			return err
		}
		notices := make([]domain.NoticeCode, 0, len(contract.Acknowledgements))
		for _, a := range contract.Acknowledgements {
			notices = append(notices, a.Code)
		}
		amendments, err := repos.Amendments.List(ctx, id)
		if err != nil {
			return err
		}
		view = &ContractView{
			Contract: contract, Property: property, Parties: parties, Rents: rents, Notices: notices,
			Amendments: amendments, Today: c.Today(),
		}
		return nil
	})
	return view, err
}

// List searches the office's contracts, newest start first.
func (c *Contracts) List(ctx context.Context, caller *Caller, q ContractQuery) (*ContractsPage, error) {
	switch q.Status {
	case "", domain.ContractUpcoming, domain.ContractActive, domain.ContractExpired, domain.ContractTerminated:
	default:
		v := &domain.ValidationError{}
		v.Add("status", "must be upcoming, active, expired or terminated")
		return nil, v
	}
	limit := q.Limit
	switch {
	case limit <= 0:
		limit = DefaultPeoplePageSize
	case limit > MaxPeoplePageSize:
		limit = MaxPeoplePageSize
	}
	q.Limit, q.Today = limit+1, c.Today()

	page := &ContractsPage{Contracts: []ContractSummary{}, Today: q.Today}
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rows, err := repos.Contracts.List(ctx, q)
		if err != nil {
			return err
		}
		if len(rows) > limit {
			rows = rows[:limit]
			last := rows[limit-1].Contract
			page.Next = &ContractCursor{StartsOn: last.StartsOn, ID: last.ID}
		}
		if rows != nil {
			page.Contracts = rows
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return page, nil
}

// Terminate ends a contract on a day, removing the unpaid instalments due
// after it.
func (c *Contracts) Terminate(ctx context.Context, caller *Caller, id uuid.UUID, on domain.Date, version int) (*ContractView, error) {
	if version <= 0 {
		return nil, fmt.Errorf("terminate contract: %w", domain.ErrPreconditionRequired)
	}
	err := c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		contract, _, rents, err := repos.Contracts.Get(ctx, id)
		if err != nil {
			return err
		}
		if contract.Version != version {
			return fmt.Errorf("terminate contract: %w", domain.ErrPreconditionFailed)
		}
		if err := domain.ValidateTermination(contract, on); err != nil {
			return err
		}
		stored := make([]domain.TerminationRent, len(rents))
		for i, r := range rents {
			stored[i] = domain.TerminationRent{Sequence: r.Sequence, Amount: r.Amount, Paid: r.PaidOn != nil}
		}
		plan, err := domain.PlanTermination(contract, on, stored)
		if err != nil {
			return err
		}
		if err := repos.Contracts.Terminate(ctx, id, on, version, c.now().UTC(), plan); err != nil {
			return err
		}
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionContractTerminated, EntityType: "contract", EntityID: &id,
			Fields: []string{"terminated_on"},
		})
	})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, caller, id)
}

// Delete removes a contract that never had a payment. One that did can only be
// terminated: its payments are the office's records.
func (c *Contracts) Delete(ctx context.Context, caller *Caller, id uuid.UUID) error {
	return c.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		paid, err := repos.Contracts.HasPayments(ctx, id)
		if err != nil {
			return err
		}
		if paid {
			return fmt.Errorf("delete contract: %w", domain.ErrInUse)
		}
		if err := repos.Contracts.Delete(ctx, id); err != nil {
			return err
		}
		return c.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionContractDeleted, EntityType: "contract", EntityID: &id,
		})
	})
}

// changedContractFields names what an update changed, for the audit trail.
func changedContractFields(before, after *domain.Contract) []string {
	var fields []string
	add := func(name string, changed bool) {
		if changed {
			fields = append(fields, name)
		}
	}
	add("property_id", before.PropertyID != after.PropertyID)
	add("registry", before.Registry != after.Registry)
	add("guarantee_kind", before.GuaranteeKind != after.GuaranteeKind)
	add("advance_rent", before.AdvanceRent != after.AdvanceRent)
	add("deposit_amount", before.DepositAmount != after.DepositAmount)
	add("rent", before.Rent != after.Rent)
	add("admin_fee", before.AdminFee != after.AdminFee)
	add("late_penalty_rate", before.LatePenaltyRate != after.LatePenaltyRate)
	add("late_interest_rate", before.LateInterestRate != after.LateInterestRate)
	add("due_day", before.DueDay != after.DueDay)
	add("adjustment_index", before.AdjustmentIndex != after.AdjustmentIndex)
	add("signed_on", before.SignedOn != after.SignedOn)
	add("starts_on", before.StartsOn != after.StartsOn)
	add("expires_on", before.ExpiresOn != after.ExpiresOn)
	add("parties", !slices.Equal(before.Parties, after.Parties))
	return fields
}
