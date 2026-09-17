//go:build integration

package http_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type amendmentItem struct {
	ID                   string  `json:"id"`
	AmendedOn            string  `json:"amended_on"`
	IndexRate            string  `json:"index_rate"`
	PreviousRent         string  `json:"previous_rent"`
	IndexedRent          string  `json:"indexed_rent"`
	PeriodAcknowledgedAt *string `json:"period_acknowledged_at"`
}

type amendedContract struct {
	contractBody
	Amendments []amendmentItem `json:"amendments"`
}

type amendmentPreview struct {
	PreviousRent  string   `json:"previous_rent"`
	SuggestedRent string   `json:"suggested_rent"`
	IndexedRent   string   `json:"indexed_rent"`
	FirstSequence int      `json:"first_sequence"`
	AffectedRents int      `json:"affected_rents"`
	FirstDueOn    *string  `json:"first_due_on"`
	Notices       []string `json:"notices"`
}

func (f *leaseFixture) amend(contractID, version string, body map[string]any) (response, amendedContract) {
	f.a.t.Helper()
	res := f.a.withHeader(http.MethodPost, "/v1/contracts/"+contractID+"/amendments", f.admin.access, "If-Match", version, body)
	var c amendedContract
	if res.status == http.StatusCreated || res.status == http.StatusOK {
		res.decode(f.a.t, &c)
	}
	return res, c
}

func TestAmendmentsAdjustTheRentFromTheirMonth(t *testing.T) {
	f := newLease(t)
	a := f.a
	c := f.create(f.contract("R-1", "2026-10-01", "2029-09-30"))
	path := "/v1/contracts/" + c.ID + "/amendments"

	// Twelve months in, 4.5%: the thirteenth month on.
	var preview amendmentPreview
	a.expect(http.StatusOK, http.MethodPost, path+"/preview", f.admin.access,
		map[string]any{"amended_on": "2027-10-01", "index_rate": "4.5"}).decode(t, &preview)
	if preview.PreviousRent != "1500.00" || preview.SuggestedRent != "1567.50" || preview.FirstSequence != 13 ||
		preview.AffectedRents != 24 || preview.FirstDueOn == nil || *preview.FirstDueOn != "2027-10-10" ||
		len(preview.Notices) != 0 {
		t.Fatalf("preview %+v", preview)
	}

	body := map[string]any{"amended_on": "2027-10-01", "index_rate": "4.5"}
	a.expect(http.StatusPreconditionRequired, http.MethodPost, path, f.admin.access, body)
	res, amended := f.amend(c.ID, `"1"`, body)
	if res.status != http.StatusCreated || res.header.Get("ETag") != `"2"` || amended.CurrentRent != "1567.50" ||
		amended.Rents[11].Amount != "1500.00" || amended.Rents[12].Amount != "1567.50" || amended.Rents[35].Amount != "1567.50" ||
		len(amended.Amendments) != 1 || amended.Amendments[0].PeriodAcknowledgedAt != nil {
		t.Fatalf("amend = %d: %+v", res.status, amended.Amendments)
	}
	if stale, _ := f.amend(c.ID, `"1"`, map[string]any{"amended_on": "2028-10-01", "index_rate": "3"}); stale.status != http.StatusPreconditionFailed {
		t.Errorf("a stale adjustment = %d", stale.status)
	}

	// A negative index suggests the same rent; the office can type a
	// negotiated one.
	a.expect(http.StatusOK, http.MethodPost, path+"/preview", f.admin.access,
		map[string]any{"amended_on": "2028-10-01", "index_rate": "-2"}).decode(t, &preview)
	if preview.SuggestedRent != "1567.50" {
		t.Errorf("a negative index suggested %s", preview.SuggestedRent)
	}
	_, amended = f.amend(c.ID, `"2"`, map[string]any{"amended_on": "2028-10-01", "index_rate": "-2", "indexed_rent": "1600.00"})
	if amended.CurrentRent != "1600.00" || amended.Rents[24].Amount != "1600.00" || amended.Rents[23].Amount != "1567.50" {
		t.Fatalf("negotiated rent %s, rents 24 and 25: %s %s", amended.CurrentRent, amended.Rents[23].Amount, amended.Rents[24].Amount)
	}

	// Less than twelve months after the last one needs the acknowledgement.
	early := map[string]any{"amended_on": "2029-03-01", "index_rate": "1"}
	refused, _ := f.amend(c.ID, `"3"`, early)
	if refused.status != http.StatusUnprocessableEntity || !strings.Contains(string(refused.body), "adjustment_period") {
		t.Fatalf("an early adjustment = %d %s", refused.status, refused.body)
	}
	early["acknowledgments"] = []string{"adjustment_period"}
	res, amended = f.amend(c.ID, `"3"`, early)
	if res.status != http.StatusCreated || amended.Amendments[2].PeriodAcknowledgedAt == nil || amended.CurrentRent != "1616.00" {
		t.Fatalf("acknowledged early adjustment = %d %+v", res.status, amended.Amendments)
	}

	// Rules on the day.
	for _, day := range []string{"2029-03-01", "2026-10-01", "2029-10-01"} {
		a.expect(http.StatusUnprocessableEntity, http.MethodPost, path+"/preview", f.admin.access,
			map[string]any{"amended_on": day, "index_rate": "1"})
	}

	// Editing the terms would undo the adjustments.
	edit := f.contract("R-1", "2026-10-01", "2029-09-30", "due_day", 5)
	if put := a.withHeader(http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, "If-Match", `"4"`, edit); put.status != http.StatusUnprocessableEntity ||
		!strings.Contains(string(put.body), `"amendments"`) {
		t.Errorf("editing an adjusted contract = %d %s", put.status, put.body)
	}

	// Only the last adjustment is undone, putting its previous rent back.
	first := a.withHeader(http.MethodDelete, path+"/"+amended.Amendments[0].ID, f.admin.access, "If-Match", `"4"`, nil)
	if first.status != http.StatusUnprocessableEntity {
		t.Errorf("undoing an older adjustment = %d", first.status)
	}
	undo := a.withHeader(http.MethodDelete, path+"/"+amended.Amendments[2].ID, f.admin.access, "If-Match", `"4"`, nil)
	var after amendedContract
	undo.decode(t, &after)
	if undo.status != http.StatusOK || after.CurrentRent != "1600.00" || len(after.Amendments) != 2 || after.Rents[35].Amount != "1600.00" {
		t.Fatalf("undo = %d, rent %s, %d adjustments", undo.status, after.CurrentRent, len(after.Amendments))
	}

	// A terminated contract takes no adjustment and keeps its own.
	a.withHeader(http.MethodPost, "/v1/contracts/"+c.ID+"/termination", f.admin.access, "If-Match", `"5"`,
		map[string]any{"terminated_on": "2029-01-31"})
	if late, _ := f.amend(c.ID, `"6"`, map[string]any{"amended_on": "2029-01-01", "index_rate": "1", "acknowledgments": []string{"adjustment_period"}}); late.status != http.StatusUnprocessableEntity {
		t.Errorf("adjusting a terminated contract = %d", late.status)
	}
	if kept := a.withHeader(http.MethodDelete, path+"/"+amended.Amendments[1].ID, f.admin.access, "If-Match", `"6"`, nil); kept.status != http.StatusUnprocessableEntity {
		t.Errorf("undoing on a terminated contract = %d", kept.status)
	}

	// Another office sees nothing.
	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusNotFound, http.MethodPost, path+"/preview", other.access, map[string]any{"amended_on": "2027-10-01", "index_rate": "1"})
}

func TestAmendmentsLeavePaidRentsAlone(t *testing.T) {
	f := newLease(t)
	a := f.a
	c := f.create(f.contract("R-2", "2026-10-01", "2028-09-30"))
	if err := a.db.InOrganizationTx(t.Context(), f.office, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `UPDATE rents SET paid_on = due_on, amount_paid = rent_amount
		                                 WHERE contract_id = $1 AND sequence = 13`, c.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	refused, _ := f.amend(c.ID, `"1"`, map[string]any{"amended_on": "2027-10-01", "index_rate": "4"})
	if refused.status != http.StatusUnprocessableEntity || !strings.Contains(string(refused.body), `"amended_on"`) {
		t.Fatalf("adjusting over a paid rent = %d %s", refused.status, refused.body)
	}
	res, amended := f.amend(c.ID, `"1"`, map[string]any{"amended_on": "2027-11-01", "index_rate": "4", "acknowledgments": []string{}})
	if res.status != http.StatusCreated || amended.Rents[12].Amount != "1500.00" || amended.Rents[13].Amount != "1560.00" {
		t.Fatalf("adjusting after the paid month = %d, rents %s %s", res.status, amended.Rents[12].Amount, amended.Rents[13].Amount)
	}
	if !slices.ContainsFunc(amended.Amendments, func(x amendmentItem) bool {
		return x.IndexRate == "4.00"
	}) {
		t.Errorf("the rate was not recorded: %+v", amended.Amendments)
	}
}
