//go:build integration

package http_test

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"imobiliary/internal/domain"
)

type rentBody struct {
	ID       string `json:"id"`
	Contract struct {
		ID          string   `json:"id"`
		Registry    string   `json:"registry"`
		TenantNames []string `json:"tenant_names"`
	} `json:"contract"`
	Sequence     int     `json:"sequence"`
	DueOn        string  `json:"due_on"`
	Amount       string  `json:"amount"`
	ChargesTotal string  `json:"charges_total"`
	Due          string  `json:"due"`
	LateFee      string  `json:"late_fee"`
	AmountPaid   *string `json:"amount_paid"`
	PaidOn       *string `json:"paid_on"`
	Status       string  `json:"status"`
	Charges      []struct {
		ID          string `json:"id"`
		Kind        string `json:"kind"`
		Description string `json:"description"`
		Amount      string `json:"amount"`
	} `json:"charges"`
	SuggestedLateFee struct {
		DaysLate int    `json:"days_late"`
		Total    string `json:"total"`
	} `json:"suggested_late_fee"`
}

// A lease that started on the first day of the month three months ago, so it
// has instalments past due whatever day the suite runs.
func (f *leaseFixture) runningLease(registry string) (contractBody, domain.Date) {
	f.a.t.Helper()
	today := domain.DateOf(time.Now(), time.UTC)
	back := today.AddMonths(-3)
	start := domain.DateInMonth(back.Year(), back.Month(), 1)
	body := f.contract(registry, start.String(), start.AddMonths(12).AddDays(-1).String(), "rent", "1600.00")
	return f.create(body), start
}

func TestRentPayments(t *testing.T) {
	f := newLease(t)
	a := f.a
	c, start := f.runningLease("P-1")
	today := domain.DateOf(time.Now(), time.UTC)

	var page struct {
		Rents []rentBody `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?status=overdue&contract_id="+c.ID, f.admin.access, nil).decode(t, &page)
	if len(page.Rents) < 3 || page.Rents[0].DueOn != start.String() || page.Rents[0].Contract.Registry != "P-1" ||
		page.Rents[0].Contract.TenantNames[0] != "Pedro Souza" {
		t.Fatalf("overdue rents %+v", page.Rents)
	}
	for _, r := range page.Rents {
		if r.Status != "overdue" {
			t.Errorf("rent %d is %s", r.Sequence, r.Status)
		}
	}
	first, second := page.Rents[0].ID, page.Rents[1].ID
	path := "/v1/rents/" + first

	var rent rentBody
	a.expect(http.StatusOK, http.MethodGet, path, f.admin.access, nil).decode(t, &rent)
	if rent.SuggestedLateFee.DaysLate != start.DaysUntil(today) {
		t.Errorf("suggested days late %d", rent.SuggestedLateFee.DaysLate)
	}

	// A charge joins what is due.
	a.expect(http.StatusCreated, http.MethodPost, path+"/charges", f.admin.access,
		map[string]any{"kind": "condominium", "amount": "400.00"}).decode(t, &rent)
	if rent.ChargesTotal != "400.00" || rent.Due != "2000.00" || len(rent.Charges) != 1 {
		t.Fatalf("after the charge %+v", rent)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, path+"/charges", f.admin.access,
		map[string]any{"kind": "other", "amount": "10.00"})

	// Five days late: 10% of 2000.00 plus 1% a month for 5 of 30 days.
	paidOn := start.AddDays(5).String()
	var preview struct {
		LateFee struct {
			DaysLate int    `json:"days_late"`
			Penalty  string `json:"penalty"`
			Interest string `json:"interest"`
			Total    string `json:"total"`
		} `json:"late_fee"`
		Total string `json:"total"`
	}
	a.expect(http.StatusOK, http.MethodPost, path+"/payment/preview", f.admin.access,
		map[string]any{"paid_on": paidOn}).decode(t, &preview)
	if preview.LateFee.DaysLate != 5 || preview.LateFee.Penalty != "200.00" || preview.LateFee.Interest != "3.33" ||
		preview.Total != "2203.33" {
		t.Fatalf("payment preview %+v", preview)
	}

	a.expect(http.StatusOK, http.MethodPost, path+"/payment", f.admin.access, map[string]any{"paid_on": paidOn}).decode(t, &rent)
	if rent.Status != "paid" || rent.AmountPaid == nil || *rent.AmountPaid != "2203.33" || rent.LateFee != "203.33" {
		t.Fatalf("paid %+v", rent)
	}
	a.expect(http.StatusConflict, http.MethodPost, path+"/payment", f.admin.access, map[string]any{"paid_on": paidOn})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, path+"/charges", f.admin.access,
		map[string]any{"kind": "water", "amount": "10.00"})
	a.expect(http.StatusUnprocessableEntity, http.MethodDelete, path+"/charges/"+rent.Charges[0].ID, f.admin.access, nil)

	// Reversal puts it back as it was.
	a.expect(http.StatusOK, http.MethodDelete, path+"/payment", f.admin.access, nil).decode(t, &rent)
	if rent.Status != "overdue" || rent.AmountPaid != nil || rent.LateFee != "0.00" {
		t.Fatalf("reversed %+v", rent)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodDelete, path+"/payment", f.admin.access, nil)

	// A late fee waived: the amount follows it unless typed.
	a.expect(http.StatusOK, http.MethodPost, path+"/payment", f.admin.access,
		map[string]any{"paid_on": paidOn, "late_fee": "0.00"}).decode(t, &rent)
	if *rent.AmountPaid != "2000.00" || rent.LateFee != "0.00" {
		t.Errorf("waived late fee %+v", rent)
	}

	// Not in the future.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/rents/"+second+"/payment", f.admin.access,
		map[string]any{"paid_on": today.AddDays(1).String()})

	// Two payments at once: one lands, the other is a conflict.
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		statuses []int
	)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := a.do(http.MethodPost, "/v1/rents/"+second+"/payment", f.admin.access, map[string]any{"paid_on": today.String()})
			mu.Lock()
			statuses = append(statuses, res.status)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if !(statuses[0] == http.StatusOK && statuses[1] == http.StatusConflict) && !(statuses[0] == http.StatusConflict && statuses[1] == http.StatusOK) {
		t.Errorf("concurrent payments answered %v", statuses)
	}

	// The contract lists the charge with its rent, and refuses a new schedule.
	var contract struct {
		Rents []struct {
			ChargesTotal string `json:"charges_total"`
		} `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+c.ID, f.admin.access, nil).decode(t, &contract)
	if contract.Rents[0].ChargesTotal != "400.00" {
		t.Errorf("contract rent charges %+v", contract.Rents[0])
	}

	// Another office sees none of it.
	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusNotFound, http.MethodGet, path, other.access, nil)
	a.expect(http.StatusNotFound, http.MethodPost, "/v1/rents/"+second+"/payment", other.access, map[string]any{"paid_on": today.String()})
}

func TestChargesBlockANewSchedule(t *testing.T) {
	f := newLease(t)
	a := f.a
	c := f.create(f.contract("S-1", "2031-01-01", "2031-12-31"))
	var page struct {
		Rents []rentBody `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?contract_id="+c.ID, f.admin.access, nil).decode(t, &page)
	a.expect(http.StatusCreated, http.MethodPost, "/v1/rents/"+page.Rents[2].ID+"/charges", f.admin.access,
		map[string]any{"kind": "property_tax", "amount": "120.00"})
	edit := f.contract("S-1", "2031-01-01", "2031-12-31", "due_day", 5)
	res := a.withHeader(http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, "If-Match", `"1"`, edit)
	if res.status != http.StatusUnprocessableEntity || !strings.Contains(string(res.body), `"rents"`) {
		t.Errorf("editing a contract with charges = %d %s", res.status, res.body)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodGet, "/v1/rents?status=late", f.admin.access, nil)
}

func TestDashboard(t *testing.T) {
	f := newLease(t)
	a := f.a
	c, _ := f.runningLease("D-1")
	today := domain.DateOf(time.Now(), time.UTC)

	var page struct {
		Rents []rentBody `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?status=overdue&contract_id="+c.ID, f.admin.access, nil).decode(t, &page)
	overdue := len(page.Rents)
	// Paid today, on time or not, it counts as received this month. The
	// administration fee takes the charge too, and never the late fee.
	a.expect(http.StatusCreated, http.MethodPost, "/v1/rents/"+page.Rents[1].ID+"/charges", f.admin.access,
		map[string]any{"kind": "condominium", "amount": "400.00"})
	a.expect(http.StatusOK, http.MethodPost, "/v1/rents/"+page.Rents[1].ID+"/payment", f.admin.access,
		map[string]any{"paid_on": today.String(), "late_fee": "35.00"})

	var d struct {
		Today string `json:"today"`
		Month struct {
			Received      string `json:"received"`
			ReceivedCount int    `json:"received_count"`
			OfficeFee     string `json:"office_fee"`
		} `json:"month"`
		Overdue struct {
			Count  int    `json:"count"`
			Amount string `json:"amount"`
		} `json:"overdue"`
		Portfolio struct {
			Properties       int    `json:"properties"`
			LeasedProperties int    `json:"leased_properties"`
			ActiveContracts  int    `json:"active_contracts"`
			RentRoll         string `json:"rent_roll"`
		} `json:"portfolio"`
		Expiring []struct {
			Registry string `json:"registry"`
		} `json:"expiring"`
		Adjustments []struct {
			Registry string `json:"registry"`
		} `json:"adjustments"`
		OverdueRents []rentBody `json:"overdue_rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/dashboard", f.admin.access, nil).decode(t, &d)
	if d.Today != today.String() || d.Month.Received != "2035.00" || d.Month.ReceivedCount != 1 || d.Month.OfficeFee != "200.00" {
		t.Errorf("month %+v", d.Month)
	}
	if d.Overdue.Count != overdue-1 || len(d.OverdueRents) != overdue-1 {
		t.Errorf("overdue %+v, %d listed, want %d", d.Overdue, len(d.OverdueRents), overdue-1)
	}
	if d.Portfolio.Properties != 1 || d.Portfolio.LeasedProperties != 1 || d.Portfolio.ActiveContracts != 1 || d.Portfolio.RentRoll != "1600.00" {
		t.Errorf("portfolio %+v", d.Portfolio)
	}
	if len(d.Expiring) != 0 || len(d.Adjustments) != 0 {
		t.Errorf("deadlines too early: %+v %+v", d.Expiring, d.Adjustments)
	}

	// A contract ending within sixty days, and one a year old without an
	// adjustment, both show.
	p2 := a.createProperty(f.admin, propertyRequest("Rua Dois", share(f.owner.ID, "100")))
	endsSoon := today.AddDays(20)
	body := f.contract("D-2", endsSoon.AddMonths(-13).String(), endsSoon.String())
	body["property_id"] = p2.ID
	f.create(body)
	a.expect(http.StatusOK, http.MethodGet, "/v1/dashboard", f.admin.access, nil).decode(t, &d)
	if len(d.Expiring) != 1 || d.Expiring[0].Registry != "D-2" || len(d.Adjustments) != 1 || d.Adjustments[0].Registry != "D-2" {
		t.Errorf("deadlines %+v %+v", d.Expiring, d.Adjustments)
	}

	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusOK, http.MethodGet, "/v1/dashboard", other.access, nil).decode(t, &d)
	if d.Portfolio.Properties != 0 || d.Overdue.Count != 0 {
		t.Errorf("another office sees %+v %+v", d.Portfolio, d.Overdue)
	}
}
