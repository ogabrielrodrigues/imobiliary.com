package usecase

import (
	"context"
	"fmt"
	"uuid"

	"imobiliary/internal/domain"
)

// The carnê-leão report (PLANO-PENDENCIAS.md §3): what an individual owner
// received through the office in a year, month by month, on the day the office
// received it. Rent paid by an individual tenant is what the carnê-leão asks
// about; rent paid by a company is withheld at source and reported by it, so
// the two are kept apart. The report adds up the ledger and nothing else: it
// computes no tax and says nothing about what is deductible, which is the
// accountant's to decide.

// TenantKind is who paid a rent: an individual, or a company.
type TenantKind string

const (
	TenantIndividual TenantKind = "individual"
	// TenantCompany is a contract with any company among its tenants.
	TenantCompany TenantKind = "company"
)

// IncomeRow is one sum of the ledger: lines of one kind, in one month, from
// rents paid by one kind of tenant. Manual lines have no tenant kind.
type IncomeRow struct {
	Month      int
	Kind       domain.EntryKind
	TenantKind TenantKind
	Amount     domain.Money
}

// IncomeFigures are the lines of rents paid by one kind of tenant.
type IncomeFigures struct {
	Rent      domain.Money
	LateFee   domain.Money
	Charges   domain.Money
	AdminFee  domain.Money
	IncomeTax domain.Money
}

func (f *IncomeFigures) add(kind domain.EntryKind, m domain.Money) {
	switch kind {
	case domain.EntryRent:
		f.Rent += m
	case domain.EntryLateFee:
		f.LateFee += m
	case domain.EntryCharge:
		f.Charges += m
	case domain.EntryAdminFee:
		f.AdminFee += m
	case domain.EntryIncomeTax:
		f.IncomeTax += m
	}
}

// IncomeMonth is a month of the report.
type IncomeMonth struct {
	Month      int
	Individual IncomeFigures
	Company    IncomeFigures
	// Debits and Credits are what the office typed, informative only.
	Debits  domain.Money
	Credits domain.Money
}

func (m *IncomeMonth) add(r IncomeRow) {
	switch {
	case r.Kind == domain.EntryDebit:
		m.Debits += r.Amount
	case r.Kind == domain.EntryCredit:
		m.Credits += r.Amount
	case r.TenantKind == TenantCompany:
		m.Company.add(r.Kind, r.Amount)
	default:
		m.Individual.add(r.Kind, r.Amount)
	}
}

// IncomeReport is a year of an owner's receipts.
type IncomeReport struct {
	Person PersonLink
	Year   int
	// Months are the twelve, January first.
	Months []IncomeMonth
	Total  IncomeMonth
}

const (
	minReportYear = 2000
	maxReportYear = 9999
)

// IncomeReport adds up an individual's ledger for a year.
func (u *Payouts) IncomeReport(ctx context.Context, caller *Caller, personID uuid.UUID, year int) (*IncomeReport, error) {
	if year < minReportYear || year > maxReportYear {
		v := &domain.ValidationError{}
		v.Add("year", "must be a year such as 2026")
		return nil, v
	}
	out := &IncomeReport{Year: year, Months: make([]IncomeMonth, 12)}
	for i := range out.Months {
		out.Months[i].Month = i + 1
	}
	err := u.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		var err error
		if out.Person, err = person(ctx, repos, personID); err != nil {
			return err
		}
		if out.Person.Kind != domain.PersonIndividual {
			v := &domain.ValidationError{}
			v.Add("person_id", "the carnê-leão report is for individuals")
			return v
		}
		rows, err := repos.Ledger.IncomeByMonth(ctx, personID,
			domain.DateInMonth(year, 1, 1), domain.DateInMonth(year, 12, 31))
		if err != nil {
			return err
		}
		for _, r := range rows {
			if r.Month < 1 || r.Month > 12 {
				return fmt.Errorf("income report: month %d", r.Month)
			}
			out.Months[r.Month-1].add(r)
			out.Total.add(r)
		}
		return nil
	})
	return out, err
}
