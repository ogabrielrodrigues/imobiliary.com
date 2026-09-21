package usecase

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Rents implements the instalments' daily work: listing them across
// contracts, receiving payments with their late fee, reversing them, charges
// billed with a rent, and the dashboard's figures.
type Rents struct {
	scope    OrganizationScope
	now      Clock
	location *time.Location
	logger   *slog.Logger
	audit    *Auditor
}

// RentsConfig collects the dependencies.
type RentsConfig struct {
	Scope    OrganizationScope
	Now      Clock
	Location *time.Location
	Logger   *slog.Logger
}

// NewRents wires the use case.
func NewRents(cfg RentsConfig) *Rents {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &Rents{
		scope: cfg.Scope, now: cfg.Now, location: cfg.Location, logger: cfg.Logger,
		audit: &Auditor{now: cfg.Now, logger: cfg.Logger},
	}
}

// Today is the current calendar day where the offices are.
func (u *Rents) Today() domain.Date { return domain.DateOf(u.now(), u.location) }

const (
	defaultRentPage = 50
	maxRentPage     = 200
)

// RentsPage is one page of the list.
type RentsPage struct {
	Rents []RentView
	Next  *RentCursor
	Today domain.Date
}

// List pages the office's instalments by due day.
func (u *Rents) List(ctx context.Context, caller *Caller, q RentQuery) (*RentsPage, error) {
	v := &domain.ValidationError{}
	if !slices.Contains([]string{"", "overdue", "pending", "open", "paid"}, q.Status) {
		v.Add("status", "must be overdue, pending, open or paid")
	}
	if q.DueFrom != nil && q.DueTo != nil && q.DueTo.Before(*q.DueFrom) {
		v.Add("due_to", "must not be before due_from")
	}
	if err := v.OrNil(); err != nil {
		return nil, err
	}
	switch {
	case q.Limit <= 0:
		q.Limit = defaultRentPage
	case q.Limit > maxRentPage:
		q.Limit = maxRentPage
	}
	q.Today = u.Today()
	want := q.Limit
	q.Limit++

	page := &RentsPage{Today: q.Today}
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rents, err := repos.Rents.List(ctx, q)
		if err != nil {
			return err
		}
		if len(rents) > want {
			rents = rents[:want]
			last := rents[want-1]
			page.Next = &RentCursor{DueOn: last.DueOn, ID: last.ID}
		}
		page.Rents = rents
		return nil
	})
	return page, err
}

// RentDetail is one instalment with what the payment screen needs.
type RentDetail struct {
	Rent *RentView
	// Suggested is the late fee for paying today; zero once paid.
	Suggested domain.LateFee
	Today     domain.Date
}

func (u *Rents) detail(rent *RentView, today domain.Date) (*RentDetail, error) {
	d := &RentDetail{Rent: rent, Today: today}
	if rent.PaidOn == nil {
		fee, err := domain.ComputeLateFee(rent.Due(), rent.DueOn, today, rent.LatePenaltyRate, rent.LateInterestRate)
		if err != nil {
			return nil, err
		}
		d.Suggested = fee
	}
	return d, nil
}

// Get reads one instalment.
func (u *Rents) Get(ctx context.Context, caller *Caller, id uuid.UUID) (*RentDetail, error) {
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		out, err = u.detail(rent, u.Today())
		return err
	})
	return out, err
}

// PaymentInput is a payment as the office records it. A nil late fee takes
// the one computed for the day. The amount received is never given: it is the
// rent, its charges and the late fee, less the tax a company tenant withheld.
type PaymentInput struct {
	PaidOn    domain.Date
	LateFee   *domain.Money
	IncomeTax domain.Money
}

// PaymentPreview is what a payment on a day would be.
type PaymentPreview struct {
	LateFee domain.LateFee
	// Total is the rent, its charges and the suggested late fee.
	Total domain.Money
}

func paymentTotals(rent *RentView, paidOn domain.Date) (*PaymentPreview, error) {
	fee, err := domain.ComputeLateFee(rent.Due(), rent.DueOn, paidOn, rent.LatePenaltyRate, rent.LateInterestRate)
	if err != nil {
		return nil, err
	}
	total, err := rent.Due().Add(fee.Total)
	if err != nil {
		return nil, err
	}
	return &PaymentPreview{LateFee: fee, Total: total}, nil
}

// PreviewPayment answers the late fee and total for paying on a day.
func (u *Rents) PreviewPayment(ctx context.Context, caller *Caller, id uuid.UUID, paidOn domain.Date) (*PaymentPreview, error) {
	if paidOn.IsZero() {
		v := &domain.ValidationError{}
		v.Add("paid_on", "is required")
		return nil, v
	}
	var out *PaymentPreview
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		out, err = paymentTotals(rent, paidOn)
		return err
	})
	return out, err
}

// Pay records an instalment as received in full. Paying one already paid is
// a conflict, which is what two concurrent payments come to.
func (u *Rents) Pay(ctx context.Context, caller *Caller, id uuid.UUID, in PaymentInput) (*RentDetail, error) {
	today := u.Today()
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		if rent.PaidOn != nil {
			return fmt.Errorf("pay rent: %w", domain.ErrConflict)
		}
		payment := domain.Payment{PaidOn: in.PaidOn, IncomeTax: in.IncomeTax}
		if !in.PaidOn.IsZero() {
			totals, err := paymentTotals(rent, in.PaidOn)
			if err != nil {
				return err
			}
			payment.LateFee = totals.LateFee.Total
		}
		if in.LateFee != nil {
			payment.LateFee = *in.LateFee
		}
		v := &domain.ValidationError{}
		domain.ValidateIncomeTax(v, in.IncomeTax, rent.Amount)
		if err := v.OrNil(); err != nil {
			return err
		}
		received, err := domain.AmountReceived(rent.Due(), payment.LateFee, payment.IncomeTax)
		if err != nil {
			return err
		}
		payment.AmountPaid = received
		if err := domain.ValidatePayment(&payment, today); err != nil {
			return err
		}
		if err := repos.Rents.Pay(ctx, id, payment); err != nil {
			return err
		}
		fields := []string{"paid_on", "amount_paid", "late_fee"}
		if payment.IncomeTax > 0 {
			fields = append(fields, "income_tax_withheld")
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionRentPaid, EntityType: "rent", EntityID: &id,
			Fields: fields,
		}); err != nil {
			return err
		}
		rent, err = repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		// What the owners are owed is written with the payment, or neither is.
		if err := writeReceipt(ctx, repos, rent, &caller.User.ID, u.now().UTC()); err != nil {
			return err
		}
		out, err = u.detail(rent, today)
		return err
	})
	return out, err
}

// Reverse puts a paid instalment back to unpaid, for a payment recorded by
// mistake or returned.
func (u *Rents) Reverse(ctx context.Context, caller *Caller, id uuid.UUID) (*RentDetail, error) {
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		if rent.PaidOn == nil {
			v := &domain.ValidationError{}
			v.Add("payment", "the rent is not paid")
			return v
		}
		if err := clearReceipt(ctx, repos, id, "payment"); err != nil {
			return err
		}
		if err := repos.Rents.Reverse(ctx, id); err != nil {
			return err
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionRentPaymentReversed, EntityType: "rent", EntityID: &id,
			Fields: []string{"paid_on", "amount_paid", "late_fee", "income_tax_withheld"},
		}); err != nil {
			return err
		}
		rent, err = repos.Rents.Get(ctx, id)
		if err != nil {
			return err
		}
		out, err = u.detail(rent, u.Today())
		return err
	})
	return out, err
}

func refuseChargesOnPaid(rent *RentView) error {
	if rent.PaidOn == nil {
		return nil
	}
	v := &domain.ValidationError{}
	v.Add("charges", "a paid rent's charges cannot change")
	return v
}

// AddCharge bills an amount with an unpaid instalment.
func (u *Rents) AddCharge(ctx context.Context, caller *Caller, rentID uuid.UUID, charge *domain.Charge) (*RentDetail, error) {
	domain.NormalizeCharge(charge)
	if err := domain.ValidateCharge(charge); err != nil {
		return nil, err
	}
	charge.ID, charge.RentID = uuid.NewV7(), rentID
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		if err := refuseChargesOnPaid(rent); err != nil {
			return err
		}
		if len(rent.Charges) >= domain.MaxChargesPerRent {
			v := &domain.ValidationError{}
			v.Addf("charges", "must be at most %d", domain.MaxChargesPerRent)
			return v
		}
		if err := repos.Rents.AddCharge(ctx, charge, u.now().UTC()); err != nil {
			return err
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionRentChargeAdded, EntityType: "rent", EntityID: &rentID,
			Fields: []string{string(charge.Kind)},
		}); err != nil {
			return err
		}
		rent, err = repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		out, err = u.detail(rent, u.Today())
		return err
	})
	return out, err
}

// RemoveCharge takes a charge off an unpaid instalment.
func (u *Rents) RemoveCharge(ctx context.Context, caller *Caller, rentID, chargeID uuid.UUID) (*RentDetail, error) {
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		if err := refuseChargesOnPaid(rent); err != nil {
			return err
		}
		i := slices.IndexFunc(rent.Charges, func(c domain.Charge) bool { return c.ID == chargeID })
		if i < 0 {
			return fmt.Errorf("remove charge: %w", domain.ErrNotFound)
		}
		if err := repos.Rents.RemoveCharge(ctx, rentID, chargeID); err != nil {
			return err
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionRentChargeRemoved, EntityType: "rent", EntityID: &rentID,
			Fields: []string{string(rent.Charges[i].Kind)},
		}); err != nil {
			return err
		}
		rent, err = repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		out, err = u.detail(rent, u.Today())
		return err
	})
	return out, err
}

// SetChargeDestination changes where a charge goes. On a paid rent it is the
// one change a charge still allows: the rent's lines are written again with
// the new destination, which is how the charges recorded before the ledger are
// put right. Refused once the rent is in a payout.
func (u *Rents) SetChargeDestination(ctx context.Context, caller *Caller, rentID, chargeID uuid.UUID, d domain.ChargeDestination) (*RentDetail, error) {
	if d != domain.DestinationOwner && d != domain.DestinationThirdParty {
		v := &domain.ValidationError{}
		v.Add("destination", "must be owner or third_party")
		return nil, v
	}
	var out *RentDetail
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rent, err := repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(rent.Charges, func(c domain.Charge) bool { return c.ID == chargeID })
		if i < 0 {
			return fmt.Errorf("charge destination: %w", domain.ErrNotFound)
		}
		if rent.Charges[i].Destination == d {
			out, err = u.detail(rent, u.Today())
			return err
		}
		if rent.PaidOn != nil {
			if err := clearReceipt(ctx, repos, rentID, "destination"); err != nil {
				return err
			}
		}
		if err := repos.Rents.SetChargeDestination(ctx, rentID, chargeID, d); err != nil {
			return err
		}
		if err := u.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID, ActorID: &caller.User.ID,
			Action: domain.ActionRentChargeDestination, EntityType: "rent", EntityID: &rentID,
			Fields: []string{string(rent.Charges[i].Kind), string(d)},
		}); err != nil {
			return err
		}
		rent, err = repos.Rents.Get(ctx, rentID)
		if err != nil {
			return err
		}
		if rent.PaidOn != nil {
			if err := writeReceipt(ctx, repos, rent, &caller.User.ID, u.now().UTC()); err != nil {
				return err
			}
		}
		out, err = u.detail(rent, u.Today())
		return err
	})
	return out, err
}

// DashboardView is the office's day at a glance.
type DashboardView struct {
	Today      domain.Date
	MonthStart domain.Date
	MonthEnd   domain.Date
	Month      MonthFigures
	// OverdueCount and OverdueAmount cover every unpaid instalment past due.
	OverdueCount  int
	OverdueAmount domain.Money
	Portfolio     Portfolio
	// Expiring are running contracts ending within the next sixty days.
	Expiring []ContractDeadline
	// Adjustments are running contracts whose twelve months end within the
	// next thirty days, or already ended without an adjustment.
	Adjustments []ContractDeadline
	DueToday    []RentView
	Overdue     []RentView
	// Payouts is what the office still owes its owners.
	Payouts PayoutFigures
}

const (
	dashboardList        = 10
	dashboardRents       = 20
	expiringHorizonDays  = 60
	adjustmentHorizonDay = 30
)

// Dashboard gathers the figures of today and the current month.
func (u *Rents) Dashboard(ctx context.Context, caller *Caller) (*DashboardView, error) {
	today := u.Today()
	start := domain.DateInMonth(today.Year(), today.Month(), 1)
	view := &DashboardView{Today: today, MonthStart: start, MonthEnd: start.AddMonths(1).AddDays(-1)}
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		if view.Month, err = repos.Dashboard.Month(ctx, view.MonthStart, view.MonthEnd); err != nil {
			return err
		}
		if view.OverdueCount, view.OverdueAmount, err = repos.Dashboard.Overdue(ctx, today); err != nil {
			return err
		}
		if view.Portfolio, err = repos.Dashboard.Portfolio(ctx, today); err != nil {
			return err
		}
		if view.Payouts, err = repos.Dashboard.Payouts(ctx); err != nil {
			return err
		}
		if view.Expiring, err = repos.Dashboard.Expiring(ctx, today, today.AddDays(expiringHorizonDays), dashboardList); err != nil {
			return err
		}
		if view.Adjustments, err = repos.Dashboard.AdjustmentsDue(ctx, today, today.AddDays(adjustmentHorizonDay), dashboardList); err != nil {
			return err
		}
		if view.DueToday, err = repos.Rents.List(ctx, RentQuery{Status: "open", DueFrom: &today, DueTo: &today, Today: today, Limit: dashboardRents}); err != nil {
			return err
		}
		view.Overdue, err = repos.Rents.List(ctx, RentQuery{Status: "overdue", Today: today, Limit: dashboardRents})
		return err
	})
	return view, err
}
