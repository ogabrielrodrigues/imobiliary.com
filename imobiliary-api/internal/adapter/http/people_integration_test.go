//go:build integration

package http_test

import (
	json "encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"uuid"

	"github.com/jackc/pgx/v5"

	"imobiliary/internal/domain"
)

// The office's register of people, over HTTP against PostgreSQL with row-level
// security forced, so the isolation proved here is the one production has.

// personBody is the part of a person these tests read.
type personBody struct {
	ID                string   `json:"id"`
	Kind              string   `json:"kind"`
	Name              string   `json:"name"`
	Email             string   `json:"email"`
	CPF               string   `json:"cpf"`
	CNPJ              string   `json:"cnpj"`
	MaritalStatus     string   `json:"marital_status"`
	SpouseID          *string  `json:"spouse_id"`
	BirthDate         *string  `json:"birth_date"`
	RepresentativeIDs []string `json:"representative_ids"`
	Addresses         []struct {
		Street  string `json:"street"`
		State   string `json:"state"`
		ZipCode string `json:"zip_code"`
	} `json:"addresses"`
	Version int `json:"version"`
}

// withHeader sends a request with one extra header, which the plain helper
// has no place for.
func (a *api) withHeader(method, path, accessToken, header, value string, body any) response {
	a.t.Helper()
	encoded := "{}"
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			a.t.Fatal(err)
		}
		encoded = string(raw)
	}
	req, err := http.NewRequestWithContext(a.t.Context(), method, a.server.URL+path, strings.NewReader(encoded))
	if err != nil {
		a.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if header != "" {
		req.Header.Set(header, value)
	}
	resp, err := a.server.Client().Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		a.t.Fatal(err)
	}
	return response{status: resp.StatusCode, body: payload, header: resp.Header}
}

// cpfSequence hands out CPFs that are valid and different from each other,
// since every individual needs one and a CPF is unique within an office.
var cpfSequence atomic.Int64

func nextCPF() string {
	base := fmt.Sprintf("%09d", 100000000+cpfSequence.Add(1))
	digit := func(digits string, weight int) byte {
		sum := 0
		for _, d := range digits {
			sum += int(d-'0') * weight
			weight--
		}
		rest := sum * 10 % 11
		if rest == 10 {
			rest = 0
		}
		return byte('0' + rest)
	}
	first := digit(base, 10)
	return base + string(first) + string(digit(base+string(first), 11))
}

// individual is the least an individual needs: a name and a CPF.
func individual(name string, fields ...any) map[string]any {
	body := map[string]any{"kind": "individual", "name": name, "cpf": nextCPF()}
	for i := 0; i+1 < len(fields); i += 2 {
		body[fields[i].(string)] = fields[i+1]
	}
	return body
}

func maria() map[string]any {
	return map[string]any{
		"kind": "individual", "name": "Maria da Conceição", "email": "maria@example.com",
		"phone": "(16) 99123-4567", "cpf": "529.982.247-25", "nationality": "brasileira",
		"marital_status": "single", "birth_date": "1984-03-09", "gender": "female",
		"addresses": []map[string]any{{
			"kind": "residential", "is_primary": true, "street": "Rua das Flores", "number": "120",
			"district": "Centro", "city": "Bebedouro", "state": "sp", "zip_code": "14700-000",
		}},
	}
}

// officeAdmin opens an office with an enrolled administrator.
func (a *api) officeAdmin(email, office string) *account {
	a.t.Helper()
	admin := a.register(email, "Ana", office)
	a.enrollTOTP(admin)
	return admin
}

func (a *api) createPerson(acc *account, body map[string]any) personBody {
	a.t.Helper()
	var p personBody
	a.expect(http.StatusCreated, http.MethodPost, "/v1/people", acc.access, body).decode(a.t, &p)
	return p
}

func TestPersonLifecycleWithSealedDocuments(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")

	created := a.expect(http.StatusCreated, http.MethodPost, "/v1/people", admin.access, maria())
	var p personBody
	created.decode(t, &p)
	if p.CPF != "529.982.247-25" || p.Email != "maria@example.com" || p.Version != 1 {
		t.Fatalf("created %+v", p)
	}
	if p.BirthDate == nil || *p.BirthDate != "1984-03-09" {
		t.Errorf("birth date %v", p.BirthDate)
	}
	if len(p.Addresses) != 1 || p.Addresses[0].State != "SP" || p.Addresses[0].ZipCode != "14700000" {
		t.Errorf("addresses %+v", p.Addresses)
	}
	if etag := created.header.Get("ETag"); etag != `"1"` {
		t.Errorf("ETag = %q", etag)
	}

	// At rest the CPF, e-mail, phone and birth date are ciphertext.
	office := uuid.MustParse(a.expect(http.StatusOK, http.MethodGet, "/v1/organization", admin.access, nil).field(t, "id"))
	err := a.db.InOrganizationTx(t.Context(), office, func(tx pgx.Tx) error {
		var email, phone, cpf, birth []byte
		if err := tx.QueryRow(t.Context(),
			`SELECT p.email, p.phone, i.cpf, i.birth_date
			   FROM people p JOIN individuals i ON i.person_id = p.id`,
		).Scan(&email, &phone, &cpf, &birth); err != nil {
			return err
		}
		for _, value := range [][]byte{email, phone, cpf, birth} {
			for _, clear := range []string{"maria@example.com", "16991234567", "52998224725", "1984-03-09"} {
				if strings.Contains(string(value), clear) {
					t.Errorf("%q is stored in the clear", clear)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Editing needs the version it was based on.
	edit := maria()
	edit["name"] = "Maria da Conceição Souza"
	edit["marital_status"] = "married"
	edit["property_regime"] = "partial_community"
	a.expect(http.StatusPreconditionRequired, http.MethodPut, "/v1/people/"+p.ID, admin.access, edit)
	updated := a.withHeader(http.MethodPut, "/v1/people/"+p.ID, admin.access, "If-Match", `"1"`, edit)
	if updated.status != http.StatusOK || updated.header.Get("ETag") != `"2"` {
		t.Fatalf("update = %d %s", updated.status, updated.body)
	}
	stale := a.withHeader(http.MethodPut, "/v1/people/"+p.ID, admin.access, "If-Match", `"1"`, edit)
	if stale.status != http.StatusPreconditionFailed {
		t.Fatalf("a stale edit = %d %s", stale.status, stale.body)
	}

	// The trail names what changed and never the values.
	var fields []string
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT fields FROM audit_events WHERE action = $1`, string(domain.ActionPersonUpdated),
	).Scan(&fields); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fields, []string{"name", "marital_status", "property_regime"}) {
		t.Errorf("audited fields %v", fields)
	}

	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/people/"+p.ID, admin.access, nil)
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/people/"+p.ID, admin.access, nil)
}

func TestPeopleValidationAndDuplicates(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")

	bad := maria()
	bad["cpf"] = "111.111.111-11"
	bad["addresses"] = []map[string]any{{"kind": "residential", "street": "", "city": "X", "state": "ZZ", "zip_code": "1"}}
	refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people", admin.access, bad)
	for _, field := range []string{`"cpf"`, `"addresses[0].street"`, `"addresses[0].state"`, `"addresses[0].zip_code"`} {
		if !strings.Contains(string(refused.body), field) {
			t.Errorf("the refusal does not name %s: %s", field, refused.body)
		}
	}

	a.createPerson(admin, maria())
	duplicate := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people", admin.access, maria())
	if !strings.Contains(string(duplicate.body), `"cpf"`) {
		t.Errorf("a repeated CPF says %s", duplicate.body)
	}

	// Another office may register the same person.
	other := a.officeAdmin("bia@example.com", "Norte")
	a.createPerson(other, maria())
}

func TestOfficesCannotSeeEachOthersPeople(t *testing.T) {
	a := newAPI(t)
	central := a.officeAdmin("ana@example.com", "Central")
	norte := a.officeAdmin("bia@example.com", "Norte")
	p := a.createPerson(central, maria())

	a.expect(http.StatusNotFound, http.MethodGet, "/v1/people/"+p.ID, norte.access, nil)
	a.expect(http.StatusNotFound, http.MethodDelete, "/v1/people/"+p.ID, norte.access, nil)
	notMine := a.withHeader(http.MethodPut, "/v1/people/"+p.ID, norte.access, "If-Match", `"1"`, maria())
	if notMine.status != http.StatusNotFound {
		t.Errorf("editing another office's person = %d", notMine.status)
	}

	var page struct {
		People []personBody `json:"people"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/people?q=529.982.247-25", norte.access, nil).decode(t, &page)
	if len(page.People) != 0 {
		t.Errorf("another office found %d people by CPF", len(page.People))
	}

	// Outside any office scope, the database shows no row at all.
	var visible int
	if err := a.db.QueryRowForTest(t.Context(), `SELECT count(*) FROM people`).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Errorf("%d people visible without a scope", visible)
	}
}

func TestSearchingAndPagingPeople(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	for _, name := range []string{"João Silva", "Beatriz Lima", "Ana Souza"} {
		a.createPerson(admin, individual(name))
	}
	a.createPerson(admin, maria())
	a.createPerson(admin, map[string]any{"kind": "company", "name": "Prado Imóveis Ltda", "cnpj": "12.ABC.345/01DE-35"})

	type page struct {
		People []struct {
			Name string `json:"name"`
		} `json:"people"`
		NextCursor string `json:"next_cursor"`
	}
	names := func(path string) ([]string, string) {
		var p page
		a.expect(http.StatusOK, http.MethodGet, path, admin.access, nil).decode(t, &p)
		var out []string
		for _, person := range p.People {
			out = append(out, person.Name)
		}
		return out, p.NextCursor
	}

	if got, _ := names("/v1/people?q=joao"); !slices.Equal(got, []string{"João Silva"}) {
		t.Errorf("q=joao found %v", got)
	}
	if got, _ := names("/v1/people?q=CONCEI"); !slices.Equal(got, []string{"Maria da Conceição"}) {
		t.Errorf("a fragment found %v", got)
	}
	if got, _ := names("/v1/people?q=52998224725"); !slices.Equal(got, []string{"Maria da Conceição"}) {
		t.Errorf("the CPF found %v", got)
	}
	if got, _ := names("/v1/people?q=12ABC34501DE35"); !slices.Equal(got, []string{"Prado Imóveis Ltda"}) {
		t.Errorf("the CNPJ found %v", got)
	}
	if got, _ := names("/v1/people?kind=company"); !slices.Equal(got, []string{"Prado Imóveis Ltda"}) {
		t.Errorf("kind=company found %v", got)
	}
	if got, _ := names("/v1/people?q=100%25"); len(got) != 0 {
		t.Errorf("a percent sign matched %v", got)
	}

	// Alphabetical, ignoring accents, two at a time.
	var all []string
	path := "/v1/people?limit=2"
	for range 5 {
		got, next := names(path)
		all = append(all, got...)
		if next == "" {
			break
		}
		path = "/v1/people?limit=2&cursor=" + next
	}
	want := []string{"Ana Souza", "Beatriz Lima", "João Silva", "Maria da Conceição", "Prado Imóveis Ltda"}
	if !slices.Equal(all, want) {
		t.Errorf("paged list %v", all)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodGet, "/v1/people?cursor=nonsense", admin.access, nil)
}

func TestSpouseLinksStaySymmetrical(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")

	pedro := a.createPerson(admin, individual("Pedro Souza", "marital_status", "married"))
	single := a.createPerson(admin, individual("Rita Alves", "marital_status", "single"))

	// A spouse must be registered as married or in a stable union.
	refused := maria()
	refused["marital_status"] = "married"
	refused["spouse_id"] = single.ID
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people", admin.access, refused)

	body := maria()
	body["marital_status"] = "married"
	body["property_regime"] = "partial_community"
	body["spouse_id"] = pedro.ID
	wife := a.createPerson(admin, body)

	var read personBody
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+pedro.ID, admin.access, nil).decode(t, &read)
	if read.SpouseID == nil || *read.SpouseID != wife.ID || read.Version != 2 {
		t.Fatalf("the other side reads spouse %v, version %d", read.SpouseID, read.Version)
	}

	// Taken: nobody else may name Pedro now.
	third := individual("Clara", "marital_status", "married", "spouse_id", pedro.ID)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people", admin.access, third)

	// Divorcing on one side clears the other.
	body["marital_status"] = "divorced"
	body["property_regime"] = ""
	body["spouse_id"] = nil
	a.withHeader(http.MethodPut, "/v1/people/"+wife.ID, admin.access, "If-Match", `"1"`, body)
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+pedro.ID, admin.access, nil).decode(t, &read)
	if read.SpouseID != nil {
		t.Errorf("Pedro still reads spouse %v", *read.SpouseID)
	}
}

func TestLinkedPeopleCannotBeDeleted(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	representative := a.createPerson(admin, maria())
	company := a.createPerson(admin, map[string]any{
		"kind": "company", "name": "Prado Imóveis Ltda", "trade_name": "Prado",
		"cnpj": "12.ABC.345/01DE-35", "representative_ids": []string{representative.ID},
	})
	if !slices.Equal(company.RepresentativeIDs, []string{representative.ID}) {
		t.Fatalf("representatives %v", company.RepresentativeIDs)
	}

	// A company cannot be a representative.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people", admin.access, map[string]any{
		"kind": "company", "name": "Outra Ltda", "representative_ids": []string{company.ID},
	})

	inUse := a.expect(http.StatusConflict, http.MethodDelete, "/v1/people/"+representative.ID, admin.access, nil)
	if !strings.Contains(string(inUse.body), "in_use") {
		t.Errorf("the refusal says %s", inUse.body)
	}
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/people/"+company.ID, admin.access, nil)
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/people/"+representative.ID, admin.access, nil)
}

func TestAnOfficeWithPeopleDoesNotCloseWithItsAccount(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	p := a.createPerson(admin, maria())

	refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/me/deletion", admin.access,
		map[string]any{"password": testPassword})
	if !strings.Contains(string(refused.body), `"organization_data"`) {
		t.Fatalf("the refusal says %s", refused.body)
	}
	// Nothing was erased by the attempt.
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+p.ID, admin.access, nil)

	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/people/"+p.ID, admin.access, nil)
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/me/deletion", admin.access,
		map[string]any{"password": testPassword})
}
