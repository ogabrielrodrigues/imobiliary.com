//go:build integration

package http_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"uuid"

	"github.com/jackc/pgx/v5"

	"imobiliary/internal/domain"
)

// Leases, against PostgreSQL with the exclusion constraint that allows one
// contract per property per period.

type contractBody struct {
	ID            string `json:"id"`
	Registry      string `json:"registry"`
	Status        string `json:"status"`
	DueDay        int    `json:"due_day"`
	TerminatedOn  string `json:"terminated_on"`
	CurrentRent   string `json:"current_rent"`
	GuaranteeKind string `json:"guarantee_kind"`
	Parties       []struct {
		PersonID string `json:"person_id"`
		Role     string `json:"role"`
		Name     string `json:"name"`
	} `json:"parties"`
	Acknowledgements []struct {
		Code string `json:"code"`
	} `json:"acknowledgments"`
	Rents []struct {
		Sequence int    `json:"sequence"`
		DueOn    string `json:"due_on"`
		Amount   string `json:"amount"`
		Status   string `json:"status"`
	} `json:"rents"`
	Version int `json:"version"`
}

type leaseFixture struct {
	a        *api
	admin    *account
	office   uuid.UUID
	owner    personBody
	tenant   personBody
	property propertyBody
}

func newLease(t *testing.T) *leaseFixture {
	t.Helper()
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	owner := a.createPerson(admin, maria())
	tenant := a.createPerson(admin, individual("Pedro Souza"))
	property := a.createProperty(admin, propertyRequest("Rua das Flores", share(owner.ID, "100")))
	office := uuid.MustParse(a.expect(http.StatusOK, http.MethodGet, "/v1/organization", admin.access, nil).field(t, "id"))
	return &leaseFixture{a: a, admin: admin, office: office, owner: owner, tenant: tenant, property: property}
}

// contract is a lease of the fixture's property, landlords left to default.
func (f *leaseFixture) contract(registry, starts, expires string, extra ...any) map[string]any {
	body := map[string]any{
		"property_id": f.property.ID, "registry": registry, "rent": "1500.00",
		"signed_on": starts, "starts_on": starts, "expires_on": expires, "due_day": 10,
		"adjustment_index": "igpm", "guarantee_kind": "none", "advance_rent": true,
		"parties": []map[string]any{{"person_id": f.tenant.ID, "role": "tenant"}},
	}
	for i := 0; i+1 < len(extra); i += 2 {
		body[extra[i].(string)] = extra[i+1]
	}
	return body
}

func (f *leaseFixture) create(body map[string]any) contractBody {
	f.a.t.Helper()
	var c contractBody
	f.a.expect(http.StatusCreated, http.MethodPost, "/v1/contracts", f.admin.access, body).decode(f.a.t, &c)
	return c
}

func TestContractLifecycle(t *testing.T) {
	f := newLease(t)
	a := f.a
	body := f.contract("2026/001", "2026-10-01", "2029-09-30")

	var preview struct {
		Parties []struct {
			PersonID string `json:"person_id"`
			Role     string `json:"role"`
		} `json:"parties"`
		Schedule []struct {
			Sequence int    `json:"sequence"`
			DueOn    string `json:"due_on"`
		} `json:"schedule"`
		Notices []string `json:"notices"`
		Total   string   `json:"total"`
	}
	a.expect(http.StatusOK, http.MethodPost, "/v1/contracts/preview", f.admin.access, body).decode(t, &preview)
	if len(preview.Schedule) != 36 || preview.Schedule[0].DueOn != "2026-10-01" || preview.Schedule[1].DueOn != "2026-11-10" {
		t.Fatalf("schedule %+v", preview.Schedule)
	}
	if len(preview.Notices) != 0 || preview.Total != "54000.00" {
		t.Errorf("notices %v, total %s", preview.Notices, preview.Total)
	}
	if len(preview.Parties) != 2 || preview.Parties[0].Role != "landlord" {
		t.Errorf("the landlord did not default to the owner: %+v", preview.Parties)
	}

	created := a.expect(http.StatusCreated, http.MethodPost, "/v1/contracts", f.admin.access, body)
	var c contractBody
	created.decode(t, &c)
	if created.header.Get("ETag") != `"1"` || len(c.Rents) != 36 || c.Parties[0].Name != "Maria da Conceição" {
		t.Fatalf("created %+v", c)
	}

	// Editing regenerates the schedule.
	body["due_day"] = 31
	a.expect(http.StatusPreconditionRequired, http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, body)
	updated := a.withHeader(http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, "If-Match", `"1"`, body)
	var after contractBody
	updated.decode(t, &after)
	if updated.status != http.StatusOK || after.Rents[4].DueOn != "2027-02-28" {
		t.Fatalf("update = %d, fifth instalment due %v", updated.status, after.Rents)
	}
	if stale := a.withHeader(http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, "If-Match", `"1"`, body); stale.status != http.StatusPreconditionFailed {
		t.Errorf("a stale edit = %d", stale.status)
	}

	// Terminating removes what would have come due afterwards: the sixth
	// instalment falls on 2027-03-31, after the termination.
	terminated := a.withHeader(http.MethodPost, "/v1/contracts/"+c.ID+"/termination", f.admin.access, "If-Match", `"2"`,
		map[string]any{"terminated_on": "2027-03-15"})
	var ended contractBody
	terminated.decode(t, &ended)
	if terminated.status != http.StatusOK || ended.Status != "terminated" || len(ended.Rents) != 5 {
		t.Fatalf("termination = %d, status %s, %d instalments", terminated.status, ended.Status, len(ended.Rents))
	}
	again := a.withHeader(http.MethodPost, "/v1/contracts/"+c.ID+"/termination", f.admin.access, "If-Match", `"3"`,
		map[string]any{"terminated_on": "2027-03-20"})
	if again.status != http.StatusUnprocessableEntity {
		t.Errorf("terminating twice = %d", again.status)
	}

	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/contracts/"+c.ID, f.admin.access, nil)
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/contracts/"+c.ID, f.admin.access, nil)
}

func TestOneLeasePerPropertyPerPeriod(t *testing.T) {
	f := newLease(t)
	a := f.a
	first := f.create(f.contract("A-1", "2026-10-01", "2027-09-30"))

	overlap := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", f.admin.access,
		f.contract("A-2", "2027-09-30", "2028-09-29"))
	if !strings.Contains(string(overlap.body), `"starts_on"`) {
		t.Errorf("an overlapping lease says %s", overlap.body)
	}
	repeated := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", f.admin.access,
		f.contract("A-1", "2030-01-01", "2030-12-31"))
	if !strings.Contains(string(repeated.body), `"registry"`) {
		t.Errorf("a repeated registry says %s", repeated.body)
	}

	// The day after the expiry is free; and a termination frees what follows.
	f.create(f.contract("A-3", "2027-10-01", "2028-09-30"))
	a.withHeader(http.MethodPost, "/v1/contracts/"+first.ID+"/termination", f.admin.access, "If-Match", `"1"`,
		map[string]any{"terminated_on": "2027-01-31"})
	f.create(f.contract("A-4", "2027-02-01", "2027-09-30"))

	// A property or a person under a contract stays.
	a.expect(http.StatusConflict, http.MethodDelete, "/v1/properties/"+f.property.ID, f.admin.access, nil)
	a.expect(http.StatusConflict, http.MethodDelete, "/v1/people/"+f.tenant.ID, f.admin.access, nil)
}

func TestLegalNoticesNeedAcknowledgement(t *testing.T) {
	f := newLease(t)
	a := f.a
	wife := a.createPerson(f.admin, individual("Clara Dias", "marital_status", "married"))
	guarantor := a.createPerson(f.admin, individual("João Dias", "marital_status", "married",
		"property_regime", "partial_community", "spouse_id", wife.ID))

	body := f.contract("F-1", "2026-10-01", "2027-09-30", "guarantee_kind", "surety", "parties", []map[string]any{
		{"person_id": f.tenant.ID, "role": "tenant"},
		{"person_id": guarantor.ID, "role": "guarantor"},
	})
	refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", f.admin.access, body)
	for _, code := range []string{"advance_rent", "guarantor_spouse_consent"} {
		if !strings.Contains(string(refused.body), code) {
			t.Errorf("the refusal does not name %s: %s", code, refused.body)
		}
	}

	body["acknowledgments"] = []string{"advance_rent", "guarantor_spouse_consent"}
	c := f.create(body)
	var codes []string
	for _, ack := range c.Acknowledgements {
		codes = append(codes, ack.Code)
	}
	if !slices.Equal(codes, []string{"advance_rent", "guarantor_spouse_consent"}) {
		t.Errorf("acknowledgements %v", codes)
	}
	var audited int
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT count(*) FROM audit_events WHERE action = $1`, string(domain.ActionNoticeAcknowledged),
	).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 2 {
		t.Errorf("%d acknowledgements audited", audited)
	}

	// With the spouse consenting, only the advance rent remains.
	body["registry"], body["starts_on"], body["expires_on"] = "F-2", "2028-01-01", "2028-12-31"
	body["parties"] = []map[string]any{
		{"person_id": f.tenant.ID, "role": "tenant"},
		{"person_id": guarantor.ID, "role": "guarantor"},
		{"person_id": wife.ID, "role": "guarantor_spouse"},
	}
	var preview struct {
		Notices []string `json:"notices"`
	}
	a.expect(http.StatusOK, http.MethodPost, "/v1/contracts/preview", f.admin.access, body).decode(t, &preview)
	if !slices.Equal(preview.Notices, []string{"advance_rent"}) {
		t.Errorf("with the spouse, notices %v", preview.Notices)
	}

	deposit := f.contract("D-1", "2029-01-01", "2029-12-31", "guarantee_kind", "deposit", "deposit_amount", "4500.01")
	a.expect(http.StatusOK, http.MethodPost, "/v1/contracts/preview", f.admin.access, deposit).decode(t, &preview)
	if !slices.Equal(preview.Notices, []string{"advance_rent", "deposit_limit"}) {
		t.Errorf("a deposit above three rents raised %v", preview.Notices)
	}
}

func TestAdvanceRentIsTheOfficesChoice(t *testing.T) {
	f := newLease(t)
	a := f.a
	var preview struct {
		Schedule []struct {
			DueOn string `json:"due_on"`
		} `json:"schedule"`
		Notices []string `json:"notices"`
	}

	// Without advance rent a guarantee needs no acknowledgement, and the first
	// month is paid on the due day of the next one.
	body := f.contract("V-1", "2026-10-01", "2027-09-30", "advance_rent", false, "guarantee_kind", "deposit", "deposit_amount", "3000.00")
	a.expect(http.StatusOK, http.MethodPost, "/v1/contracts/preview", f.admin.access, body).decode(t, &preview)
	if len(preview.Notices) != 0 || len(preview.Schedule) != 12 || preview.Schedule[0].DueOn != "2026-11-10" ||
		preview.Schedule[11].DueOn != "2027-10-10" {
		t.Fatalf("without advance rent: notices %v, schedule %v", preview.Notices, preview.Schedule)
	}
	c := f.create(body)
	if c.Rents[0].DueOn != "2026-11-10" {
		t.Errorf("stored first rent due %s", c.Rents[0].DueOn)
	}

	// With it, the same guarantee asks for the acknowledgement.
	body["advance_rent"] = true
	a.expect(http.StatusOK, http.MethodPost, "/v1/contracts/preview", f.admin.access, body).decode(t, &preview)
	if !slices.Equal(preview.Notices, []string{"advance_rent"}) || preview.Schedule[0].DueOn != "2026-10-01" {
		t.Errorf("with advance rent: notices %v, schedule %v", preview.Notices, preview.Schedule)
	}

	delete(body, "advance_rent")
	missing := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts/preview", f.admin.access, body)
	if !strings.Contains(string(missing.body), `"advance_rent"`) {
		t.Errorf("an absent choice says %s", missing.body)
	}
}

func TestContractRules(t *testing.T) {
	f := newLease(t)
	a := f.a
	for name, c := range map[string]struct {
		body  map[string]any
		field string
	}{
		"the tenant as guarantor": {f.contract("R-1", "2026-10-01", "2027-09-30", "guarantee_kind", "surety", "parties", []map[string]any{
			{"person_id": f.tenant.ID, "role": "tenant"}, {"person_id": f.tenant.ID, "role": "guarantor"},
		}), `"parties"`},
		"a guarantor without surety": {f.contract("R-2", "2026-10-01", "2027-09-30", "parties", []map[string]any{
			{"person_id": f.tenant.ID, "role": "tenant"}, {"person_id": f.owner.ID, "role": "guarantor"},
		}), `"parties"`},
		"a deposit with no amount": {f.contract("R-3", "2026-10-01", "2027-09-30", "guarantee_kind", "deposit"), `"deposit_amount"`},
		"a rent that is not money": {f.contract("R-4", "2026-10-01", "2027-09-30", "rent", "mil"), `"rent"`},
		"no tenant":                {f.contract("R-5", "2026-10-01", "2027-09-30", "parties", []map[string]any{}), `"parties"`},
	} {
		t.Run(name, func(t *testing.T) {
			refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", f.admin.access, c.body)
			if !strings.Contains(string(refused.body), c.field) {
				t.Errorf("the refusal does not name %s: %s", c.field, refused.body)
			}
		})
	}

	// Another office sees nothing.
	c := f.create(f.contract("R-6", "2026-10-01", "2027-09-30"))
	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/contracts/"+c.ID, other.access, nil)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", other.access,
		map[string]any{"property_id": f.property.ID, "registry": "X", "rent": "1.00", "signed_on": "2026-01-01",
			"starts_on": "2026-01-01", "expires_on": "2026-12-31", "due_day": 1})
}

func TestAPaidContractIsTerminatedNotDeleted(t *testing.T) {
	f := newLease(t)
	a := f.a
	c := f.create(f.contract("P-1", "2026-10-01", "2027-09-30"))

	// Payments are phase 6; the rule only needs one on record.
	if err := a.db.InOrganizationTx(t.Context(), f.office, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `UPDATE rents SET paid_on = due_on, amount_paid = rent_amount
		                                 WHERE contract_id = $1 AND sequence = 1`, c.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	a.expect(http.StatusConflict, http.MethodDelete, "/v1/contracts/"+c.ID, f.admin.access, nil)
	edit := f.contract("P-1", "2026-10-01", "2027-09-30", "due_day", 5)
	if refused := a.withHeader(http.MethodPut, "/v1/contracts/"+c.ID, f.admin.access, "If-Match", `"1"`, edit); refused.status != http.StatusUnprocessableEntity {
		t.Errorf("editing a paid contract = %d", refused.status)
	}
	ended := a.withHeader(http.MethodPost, "/v1/contracts/"+c.ID+"/termination", f.admin.access, "If-Match", `"1"`,
		map[string]any{"terminated_on": "2026-10-01"})
	var body contractBody
	ended.decode(t, &body)
	if ended.status != http.StatusOK || len(body.Rents) != 1 || body.Rents[0].Status != "paid" {
		t.Errorf("termination = %d, rents %+v", ended.status, body.Rents)
	}

	var page struct {
		Contracts []contractBody `json:"contracts"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts?status=terminated&q=pedro", f.admin.access, nil).decode(t, &page)
	if len(page.Contracts) != 1 || page.Contracts[0].Registry != "P-1" {
		t.Errorf("list %+v", page.Contracts)
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts?status=active", f.admin.access, nil).decode(t, &page)
	if len(page.Contracts) != 0 {
		t.Errorf("active list %+v", page.Contracts)
	}
}
