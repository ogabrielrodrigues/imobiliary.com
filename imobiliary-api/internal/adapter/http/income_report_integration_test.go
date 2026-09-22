//go:build integration

package http_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"imobiliary/internal/domain"
)

type incomeFigures struct {
	Rent      string `json:"rent"`
	LateFee   string `json:"late_fee"`
	Charges   string `json:"charges"`
	AdminFee  string `json:"admin_fee"`
	IncomeTax string `json:"income_tax"`
}

type incomeMonth struct {
	Month      int           `json:"month"`
	Individual incomeFigures `json:"individual"`
	Company    incomeFigures `json:"company"`
	Debits     string        `json:"debits"`
	Credits    string        `json:"credits"`
}

// Maria owns two properties: one leased to a person, one to a company that
// withholds income tax. The report keeps the two apart, month by month.
func TestIncomeReport(t *testing.T) {
	f := newLease(t)
	a := f.a
	today := domain.DateOf(time.Now(), time.UTC)
	back := today.AddMonths(-3)
	start := domain.DateInMonth(back.Year(), back.Month(), 1)
	expires := start.AddMonths(12).AddDays(-1).String()

	firstRent := func(contractID string) string {
		var page struct {
			Rents []struct {
				ID string `json:"id"`
			} `json:"rents"`
		}
		a.expect(http.StatusOK, http.MethodGet, "/v1/rents?contract_id="+contractID, f.admin.access, nil).decode(t, &page)
		return "/v1/rents/" + page.Rents[0].ID
	}

	person := f.create(f.contract("I-1", start.String(), expires))
	a.expect(http.StatusOK, http.MethodPost, firstRent(person.ID)+"/payment", f.admin.access,
		map[string]any{"paid_on": start.String()})

	company := a.createPerson(f.admin, map[string]any{"kind": "company", "name": "Prado Comércio Ltda", "cnpj": "12.ABC.345/01DE-35"})
	second := a.createProperty(f.admin, propertyRequest("Rua da Empresa", share(f.owner.ID, "100")))
	body := f.contract("C-1", start.String(), expires)
	body["property_id"] = second.ID
	body["parties"] = []map[string]any{{"person_id": company.ID, "role": "tenant"}}
	leased := f.create(body)
	a.expect(http.StatusOK, http.MethodPost, firstRent(leased.ID)+"/payment", f.admin.access,
		map[string]any{"paid_on": start.String(), "income_tax_withheld": "22.50"})

	a.expect(http.StatusCreated, http.MethodPost, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, map[string]any{
		"kind": "debit", "amount": "10.00", "description": "Conserto", "occurred_on": today.String(),
	})

	var report struct {
		Year   int           `json:"year"`
		Months []incomeMonth `json:"months"`
		Total  incomeMonth   `json:"total"`
	}
	path := "/v1/people/" + f.owner.ID + "/income-report?year=" + strconv.Itoa(start.Year())
	a.expect(http.StatusOK, http.MethodGet, path, f.admin.access, nil).decode(t, &report)
	if len(report.Months) != 12 || report.Year != start.Year() {
		t.Fatalf("report %+v", report)
	}
	m := report.Months[int(start.Month())-1]
	if m.Individual.Rent != "1500.00" || m.Individual.AdminFee != "150.00" || m.Individual.IncomeTax != "0.00" {
		t.Errorf("rent from a person %+v", m.Individual)
	}
	if m.Company.Rent != "1500.00" || m.Company.AdminFee != "150.00" || m.Company.IncomeTax != "22.50" {
		t.Errorf("rent from a company %+v", m.Company)
	}
	if report.Total.Individual.Rent != "1500.00" || report.Total.Company.Rent != "1500.00" {
		t.Errorf("total %+v", report.Total)
	}
	if today.Year() == start.Year() {
		if got := report.Months[int(today.Month())-1].Debits; got != "10.00" {
			t.Errorf("debits in the month typed: %s", got)
		}
	}

	a.expect(http.StatusUnprocessableEntity, http.MethodGet, "/v1/people/"+company.ID+"/income-report?year=2026", f.admin.access, nil)
	a.expect(http.StatusUnprocessableEntity, http.MethodGet, "/v1/people/"+f.owner.ID+"/income-report?year=26", f.admin.access, nil)
	a.expect(http.StatusUnprocessableEntity, http.MethodGet, "/v1/people/"+f.owner.ID+"/income-report", f.admin.access, nil)
}
