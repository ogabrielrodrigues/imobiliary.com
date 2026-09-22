//go:build integration

package http_test

import (
	"net/http"
	"strconv"
	"testing"

	"imobiliary/internal/domain"
)

type candidatesBody struct {
	Candidates []struct {
		Person struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"person"`
		LastActivityOn   string `json:"last_activity_on"`
		RetentionEndedOn string `json:"retention_ended_on"`
		Contracts        []struct {
			ID             string `json:"id"`
			DocumentsCanGo bool   `json:"documents_can_go"`
		} `json:"contracts"`
	} `json:"candidates"`
}

// A lease that ended in 2018: its tenant is past the tax retention and can be
// anonymised; the co-tenant cannot, because her husband's record, which
// has no end, still names her; the owner cannot, since she owns a property.
func TestAnonymizationAtTheEndOfTheRetention(t *testing.T) {
	f := newLease(t)
	a := f.a
	beto := a.createPerson(f.admin, individual("Beto Alves", "marital_status", "married"))
	ana := a.createPerson(f.admin, individual("Ana Alves", "marital_status", "married", "spouse_id", beto.ID,
		"addresses", []map[string]any{{
			"kind": "residential", "is_primary": true, "street": "Rua Velha", "number": "1",
			"district": "Centro", "city": "Colina", "state": "SP", "zip_code": "14770-000",
		}}))
	body := f.contract("A-2018", "2018-01-01", "2018-12-31")
	body["parties"] = []map[string]any{{"person_id": f.tenant.ID, "role": "tenant"}, {"person_id": ana.ID, "role": "tenant"}}
	old := f.create(body)

	var page struct {
		Rents []struct {
			ID string `json:"id"`
		} `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?contract_id="+old.ID, f.admin.access, nil).decode(t, &page)
	a.expect(http.StatusOK, http.MethodPost, "/v1/rents/"+page.Rents[0].ID+"/payment", f.admin.access,
		map[string]any{"paid_on": "2018-01-01"})

	var found candidatesBody
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/anonymization-candidates", f.admin.access, nil).decode(t, &found)
	if len(found.Candidates) != 1 || found.Candidates[0].Person.ID != f.tenant.ID {
		t.Fatalf("candidates %+v", found.Candidates)
	}
	c := found.Candidates[0]
	if c.LastActivityOn != "2018-12-31" || c.RetentionEndedOn != "2024-01-01" {
		t.Errorf("dates %+v", c)
	}
	// The contract names Ana and the owner too, so its documents stay.
	if len(c.Contracts) != 1 || c.Contracts[0].ID != old.ID || c.Contracts[0].DocumentsCanGo {
		t.Errorf("contracts %+v", c.Contracts)
	}

	// Only a candidate is anonymised.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people/"+ana.ID+"/anonymization", f.admin.access, nil)
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/people/"+f.tenant.ID+"/anonymization", f.admin.access, nil)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people/"+f.tenant.ID+"/anonymization", f.admin.access, nil)

	var person struct {
		Name         string  `json:"name"`
		CPF          string  `json:"cpf"`
		Version      int     `json:"version"`
		AnonymizedAt *string `json:"anonymized_at"`
		Addresses    []any   `json:"addresses"`
	}
	got := a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.tenant.ID, f.admin.access, nil)
	got.decode(t, &person)
	if person.Name != "Pessoa anonimizada" || person.CPF != "" || person.AnonymizedAt == nil || len(person.Addresses) != 0 {
		t.Fatalf("anonymised person %+v", person)
	}

	// The record is never edited again, and its CPF can name someone new.
	edit := individual("Pedro Souza")
	refused := a.withHeader(http.MethodPut, "/v1/people/"+f.tenant.ID, f.admin.access, "If-Match",
		`"`+strconv.Itoa(person.Version)+`"`, edit)
	if refused.status != http.StatusUnprocessableEntity {
		t.Errorf("editing an anonymised person: %d %s", refused.status, refused.body)
	}
	a.createPerson(f.admin, map[string]any{"kind": "individual", "name": "Outro Pedro", "cpf": f.tenant.CPF})

	// The contract still stands, naming the anonymised record.
	var contract struct {
		Parties []struct {
			PersonID string `json:"person_id"`
			Name     string `json:"name"`
		} `json:"parties"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+old.ID, f.admin.access, nil).decode(t, &contract)
	named := false
	for _, p := range contract.Parties {
		named = named || (p.PersonID == f.tenant.ID && p.Name == "Pessoa anonimizada")
	}
	if !named {
		t.Errorf("contract parties %+v", contract.Parties)
	}

	var actions []string
	rows, err := a.db.QueryForTest(t.Context(), `SELECT action FROM audit_events WHERE action = $1`, string(domain.ActionPersonAnonymized))
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		_ = rows.Scan(&action)
		actions = append(actions, action)
	}
	rows.Close()
	if len(actions) != 1 {
		t.Errorf("audit %v", actions)
	}
}
