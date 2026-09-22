//go:build integration

package http_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"imobiliary/internal/domain"
)

type partialRent struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	PaidOn        *string `json:"paid_on"`
	AmountPaid    *string `json:"amount_paid"`
	PrincipalPaid string  `json:"principal_paid"`
	Outstanding   string  `json:"outstanding"`
	PartiallyPaid bool    `json:"partially_paid"`
	OwedToday     string  `json:"owed_today"`
	Payments      []struct {
		ID        string `json:"id"`
		Amount    string `json:"amount"`
		LateFee   string `json:"late_fee"`
		Principal string `json:"principal"`
	} `json:"payments"`
}

// A rent of 1500.00 with an owner's IPTU of 300.00, paid in two parts: the
// first settles the interest and penalty, then part of the principal; the
// second, a month on, pays the interest on what was left and the rest.
func TestPartialPayments(t *testing.T) {
	f := newLease(t)
	a := f.a
	today := domain.DateOf(time.Now(), time.UTC)
	back := today.AddMonths(-3)
	start := domain.DateInMonth(back.Year(), back.Month(), 1)
	c := f.create(f.contract("P-1", start.String(), start.AddMonths(12).AddDays(-1).String()))

	var page struct {
		Rents []struct {
			ID string `json:"id"`
		} `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?contract_id="+c.ID, f.admin.access, nil).decode(t, &page)
	rentPath := "/v1/rents/" + page.Rents[0].ID
	a.expect(http.StatusCreated, http.MethodPost, rentPath+"/charges", f.admin.access,
		map[string]any{"kind": "property_tax", "amount": "300.00", "destination": "owner"})

	first := start.AddDays(10).String()
	// More than is owed, and the old field, are refused.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": first, "amount": "1986.01"})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": first, "amount_paid": "900.00"})

	// Ten days late: 10% of 1800.00 and 1% a month for ten days, 186.00, come
	// first; 714.00 go to the principal.
	var rent partialRent
	a.expect(http.StatusOK, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": first, "amount": "900.00"}).decode(t, &rent)
	if rent.PaidOn != nil || !rent.PartiallyPaid || rent.Status != "overdue" || rent.Outstanding != "1086.00" ||
		len(rent.Payments) != 1 || rent.Payments[0].LateFee != "186.00" || rent.Payments[0].Principal != "714.00" {
		t.Fatalf("after the first part %+v", rent)
	}

	// The owner's lines: 714.00 split 1500:300 into 595.00 and 119.00, the
	// whole late fee, less 10% of the rent and IPTU settled.
	var ledger personLedger
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &ledger)
	want := map[string]string{"rent": "595.00", "charge": "119.00", "late_fee": "186.00", "admin_fee": "71.40"}
	got := kindTotals(ledger.Pending)
	for k, v := range want {
		if got[k] != v {
			t.Errorf("first part %s = %s, want %s", k, got[k], v)
		}
	}
	if ledger.Balance != "828.60" {
		t.Fatalf("balance after the first part %s", ledger.Balance)
	}

	// With money in, the charges stay as they are, and a payment cannot go
	// before the last one.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/charges", f.admin.access,
		map[string]any{"kind": "water", "amount": "10.00", "destination": "third_party"})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": start.AddDays(9).String()})

	// Thirty days on, 1% of 1086.00 is owed besides it; paying in full is
	// computed.
	second := start.AddDays(40).String()
	var preview struct {
		Principal string `json:"principal"`
		Total     string `json:"total"`
		LateFee   struct {
			Penalty  string `json:"penalty"`
			Interest string `json:"interest"`
		} `json:"late_fee"`
	}
	a.expect(http.StatusOK, http.MethodPost, rentPath+"/payment/preview", f.admin.access,
		map[string]any{"paid_on": second}).decode(t, &preview)
	if preview.Principal != "1086.00" || preview.LateFee.Interest != "10.86" || preview.LateFee.Penalty != "0.00" ||
		preview.Total != "1096.86" {
		t.Fatalf("preview %+v", preview)
	}
	a.expect(http.StatusOK, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": second}).decode(t, &rent)
	if rent.PaidOn == nil || *rent.PaidOn != second || rent.PartiallyPaid || rent.Status != "paid" ||
		rent.AmountPaid == nil || *rent.AmountPaid != "1996.86" || rent.Outstanding != "0.00" {
		t.Fatalf("after paying the rest %+v", rent)
	}
	a.expect(http.StatusConflict, http.MethodPost, rentPath+"/payment", f.admin.access, map[string]any{"paid_on": second})

	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &ledger)
	// 905.00 + 181.00 + 10.86 − 108.60 more.
	if ledger.Balance != "1816.86" {
		t.Fatalf("balance after the rest %s", ledger.Balance)
	}

	// Reversing undoes the last payment only.
	a.expect(http.StatusOK, http.MethodDelete, rentPath+"/payment", f.admin.access, nil).decode(t, &rent)
	if !rent.PartiallyPaid || len(rent.Payments) != 1 || rent.Outstanding != "1086.00" {
		t.Fatalf("after reversing %+v", rent)
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &ledger)
	if ledger.Balance != "828.60" {
		t.Fatalf("balance after reversing %s", ledger.Balance)
	}

	// Paid out, the first part can no longer be reversed.
	var payout payoutResponse
	a.expect(http.StatusCreated, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": f.owner.ID, "paid_on": today.String(), "entry_ids": lineIDs(ledger.Pending), "method": "pix",
	}).decode(t, &payout)
	refused := a.expect(http.StatusUnprocessableEntity, http.MethodDelete, rentPath+"/payment", f.admin.access, nil)
	if !strings.Contains(string(refused.body), payout.Number) {
		t.Errorf("the refusal does not name the payout: %s", refused.body)
	}

	// The contract keeps a partially paid rent out of a termination's reach
	// like a paid one.
	var contract struct {
		Rents []struct {
			PartiallyPaid bool `json:"partially_paid"`
		} `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+c.ID, f.admin.access, nil).decode(t, &contract)
	if !contract.Rents[0].PartiallyPaid {
		t.Errorf("the contract does not mark the rent partially paid")
	}
}
