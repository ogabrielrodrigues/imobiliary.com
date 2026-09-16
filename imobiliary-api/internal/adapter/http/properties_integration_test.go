//go:build integration

package http_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"uuid"

	"github.com/jackc/pgx/v5"
)

// The office's properties, against PostgreSQL with forced row-level security
// and the deferred trigger that keeps owners' shares at 100%.

type propertyBody struct {
	ID      string `json:"id"`
	Address struct {
		Street  string `json:"street"`
		City    string `json:"city"`
		State   string `json:"state"`
		ZipCode string `json:"zip_code"`
	} `json:"address"`
	Registry string `json:"registry"`
	Owners   []struct {
		PersonID string `json:"person_id"`
		Share    string `json:"share"`
		Name     string `json:"name"`
	} `json:"owners"`
	Version int `json:"version"`
}

func propertyRequest(street string, owners ...map[string]any) map[string]any {
	return map[string]any{
		"address": map[string]any{
			"street": street, "number": "120", "district": "Centro", "city": "Bebedouro",
			"state": "sp", "zip_code": "14700-000",
		},
		"registry":               "12.345",
		"registry_office":        "1º Cartório de Registro de Imóveis de Bebedouro",
		"municipal_registration": "01.02.003.0045",
		"owners":                 owners,
	}
}

func share(personID, value string) map[string]any {
	return map[string]any{"person_id": personID, "share": value}
}

func (a *api) createProperty(acc *account, body map[string]any) propertyBody {
	a.t.Helper()
	var p propertyBody
	a.expect(http.StatusCreated, http.MethodPost, "/v1/properties", acc.access, body).decode(a.t, &p)
	return p
}

func TestPropertyLifecycleWithOwners(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	maria := a.createPerson(admin, maria())
	pedro := a.createPerson(admin, map[string]any{"kind": "individual", "name": "Pedro Souza"})

	created := a.expect(http.StatusCreated, http.MethodPost, "/v1/properties", admin.access,
		propertyRequest("Rua das Flores", share(maria.ID, "50"), share(pedro.ID, "50")))
	var p propertyBody
	created.decode(t, &p)
	if created.header.Get("ETag") != `"1"` || p.Address.State != "SP" || p.Address.ZipCode != "14700000" {
		t.Fatalf("created %+v with ETag %q", p, created.header.Get("ETag"))
	}
	if len(p.Owners) != 2 || p.Owners[0].Name != "Maria da Conceição" || p.Owners[0].Share != "50.00" {
		t.Fatalf("owners %+v", p.Owners)
	}

	// A third each, the last taking the remainder, replaces the halves.
	clara := a.createPerson(admin, map[string]any{"kind": "individual", "name": "Clara Dias"})
	edit := propertyRequest("Rua das Flores", share(maria.ID, "33.3333"), share(pedro.ID, "33.3333"), share(clara.ID, "33.3334"))
	a.expect(http.StatusPreconditionRequired, http.MethodPut, "/v1/properties/"+p.ID, admin.access, edit)
	updated := a.withHeader(http.MethodPut, "/v1/properties/"+p.ID, admin.access, "If-Match", `"1"`, edit)
	if updated.status != http.StatusOK {
		t.Fatalf("update = %d %s", updated.status, updated.body)
	}
	var after propertyBody
	updated.decode(t, &after)
	if len(after.Owners) != 3 || after.Owners[2].Share != "33.3334" || after.Version != 2 {
		t.Errorf("after the update %+v", after)
	}
	stale := a.withHeader(http.MethodPut, "/v1/properties/"+p.ID, admin.access, "If-Match", `"1"`, edit)
	if stale.status != http.StatusPreconditionFailed {
		t.Errorf("a stale edit = %d", stale.status)
	}

	// An owner cannot be deleted while they own a share.
	a.expect(http.StatusConflict, http.MethodDelete, "/v1/people/"+clara.ID, admin.access, nil)

	// Deleting the property takes its owners and its address with it, and
	// frees the owners.
	office := uuid.MustParse(a.expect(http.StatusOK, http.MethodGet, "/v1/organization", admin.access, nil).field(t, "id"))
	countAddresses := func() int {
		var n int
		if err := a.db.InOrganizationTx(t.Context(), office, func(tx pgx.Tx) error {
			return tx.QueryRow(t.Context(), `SELECT count(*) FROM addresses`).Scan(&n)
		}); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := countAddresses()
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/properties/"+p.ID, admin.access, nil)
	if got := countAddresses(); got != before-1 {
		t.Errorf("addresses went from %d to %d", before, got)
	}
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/properties/"+p.ID, admin.access, nil)
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/people/"+clara.ID, admin.access, nil)
}

func TestPropertyRulesAndIsolation(t *testing.T) {
	a := newAPI(t)
	central := a.officeAdmin("ana@example.com", "Central")
	norte := a.officeAdmin("bia@example.com", "Norte")
	mine := a.createPerson(central, maria())
	theirs := a.createPerson(norte, maria())

	for name, c := range map[string]struct {
		body  map[string]any
		field string
	}{
		"shares short of 100":          {propertyRequest("Rua A", share(mine.ID, "90")), `"owners"`},
		"no owners":                    {propertyRequest("Rua A"), `"owners"`},
		"a share that is not a number": {propertyRequest("Rua A", share(mine.ID, "cem")), `"owners[0].share"`},
		"no street":                    {propertyRequest("", share(mine.ID, "100")), `"address.street"`},
		"another office's person":      {propertyRequest("Rua A", share(theirs.ID, "100")), `"owners[0].person_id"`},
	} {
		t.Run(name, func(t *testing.T) {
			refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/properties", central.access, c.body)
			if !strings.Contains(string(refused.body), c.field) {
				t.Errorf("the refusal does not name %s: %s", c.field, refused.body)
			}
		})
	}

	p := a.createProperty(central, propertyRequest("Rua das Flores", share(mine.ID, "100")))
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/properties/"+p.ID, norte.access, nil)
	a.expect(http.StatusNotFound, http.MethodDelete, "/v1/properties/"+p.ID, norte.access, nil)
	var page struct {
		Properties []propertyBody `json:"properties"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/properties", norte.access, nil).decode(t, &page)
	if len(page.Properties) != 0 {
		t.Errorf("another office lists %d properties", len(page.Properties))
	}
}

func TestSharesAreCheckedByTheDatabaseAtCommit(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	owner := a.createPerson(admin, maria())
	p := a.createProperty(admin, propertyRequest("Rua das Flores", share(owner.ID, "100")))
	office := uuid.MustParse(a.expect(http.StatusOK, http.MethodGet, "/v1/organization", admin.access, nil).field(t, "id"))

	// Bypassing the domain, a share that breaks the sum is refused when the
	// transaction commits, not when the row is written.
	err := a.db.InOrganizationTx(t.Context(), office, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `UPDATE property_owners SET share = 500000 WHERE property_id = $1`, p.ID)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "SQLSTATE 23514") {
		t.Fatalf("the commit answered %v", err)
	}
	var read propertyBody
	a.expect(http.StatusOK, http.MethodGet, "/v1/properties/"+p.ID, admin.access, nil).decode(t, &read)
	if read.Owners[0].Share != "100.00" {
		t.Errorf("the share is now %s", read.Owners[0].Share)
	}
}

func TestSearchingProperties(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	maria := a.createPerson(admin, maria())
	pedro := a.createPerson(admin, map[string]any{"kind": "individual", "name": "Pedro Souza"})
	a.createProperty(admin, propertyRequest("Rua das Flores", share(maria.ID, "100")))
	a.createProperty(admin, propertyRequest("Avenida Brasil", share(pedro.ID, "100")))
	other := propertyRequest("Travessa São João", share(maria.ID, "60"), share(pedro.ID, "40"))
	other["address"].(map[string]any)["city"] = "Ribeirão Preto"
	other["registry"] = "98.765"
	a.createProperty(admin, other)

	streets := func(path string) ([]string, string) {
		var page struct {
			Properties []propertyBody `json:"properties"`
			NextCursor string         `json:"next_cursor"`
		}
		a.expect(http.StatusOK, http.MethodGet, path, admin.access, nil).decode(t, &page)
		var out []string
		for _, p := range page.Properties {
			out = append(out, p.Address.Street)
		}
		return out, page.NextCursor
	}

	for path, want := range map[string][]string{
		"/v1/properties?q=flores":             {"Rua das Flores"},
		"/v1/properties?q=ribeirao":           {"Travessa São João"},
		"/v1/properties?q=98.765":             {"Travessa São João"},
		"/v1/properties?owner_id=" + pedro.ID: {"Avenida Brasil", "Travessa São João"},
	} {
		if got, _ := streets(path); !slices.Equal(got, want) {
			t.Errorf("%s found %v, want %v", path, got, want)
		}
	}

	var all []string
	path := "/v1/properties?limit=2"
	for range 3 {
		got, next := streets(path)
		all = append(all, got...)
		if next == "" {
			break
		}
		path = "/v1/properties?limit=2&cursor=" + next
	}
	if want := []string{"Avenida Brasil", "Rua das Flores", "Travessa São João"}; !slices.Equal(all, want) {
		t.Errorf("paged list %v", all)
	}
}
