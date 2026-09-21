//go:build integration

package http_test

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"imobiliary/internal/domain"
)

type ledgerLine struct {
	ID       string  `json:"id"`
	PersonID string  `json:"person_id"`
	Kind     string  `json:"kind"`
	Amount   string  `json:"amount"`
	Signed   string  `json:"signed"`
	RentID   *string `json:"rent_id"`
	PayoutID *string `json:"payout_id"`
}

type personLedger struct {
	Person struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"person"`
	Balance string       `json:"balance"`
	Pending []ledgerLine `json:"pending"`
}

type payoutResponse struct {
	ID     string `json:"id"`
	Number string `json:"number"`
	Person struct {
		ID string `json:"id"`
	} `json:"person"`
	Total   string       `json:"total"`
	Entries []ledgerLine `json:"entries"`
}

func lineIDs(lines []ledgerLine) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = l.ID
	}
	return out
}

func kindTotals(lines []ledgerLine) map[string]string {
	out := map[string]string{}
	for _, l := range lines {
		if prev, ok := out[l.Kind]; ok {
			a, _ := domain.ParseMoney(prev)
			b, _ := domain.ParseMoney(l.Amount)
			out[l.Kind] = (a + b).String()
			continue
		}
		out[l.Kind] = l.Amount
	}
	return out
}

// A property of two owners, 70% and 30%, leased from three months ago, and its
// first rent paid late with an IPTU for the owners, a condominium passed on to
// a third party, a late fee and the income tax a company tenant kept.
func TestLedgerFromAPaidRent(t *testing.T) {
	f := newLease(t)
	a := f.a
	bia := a.createPerson(f.admin, individual("Bia Lima"))
	property := a.createProperty(f.admin, propertyRequest("Rua do Repasse", share(f.owner.ID, "70"), share(bia.ID, "30")))
	today := domain.DateOf(time.Now(), time.UTC)
	back := today.AddMonths(-3)
	start := domain.DateInMonth(back.Year(), back.Month(), 1)
	body := f.contract("R-1", start.String(), start.AddMonths(12).AddDays(-1).String(), "rent", "1600.00")
	body["property_id"] = property.ID
	c := f.create(body)

	var page struct {
		Rents []rentBody `json:"rents"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/rents?contract_id="+c.ID, f.admin.access, nil).decode(t, &page)
	rentPath := "/v1/rents/" + page.Rents[0].ID
	a.expect(http.StatusCreated, http.MethodPost, rentPath+"/charges", f.admin.access,
		map[string]any{"kind": "property_tax", "amount": "120.00", "destination": "owner"})
	a.expect(http.StatusCreated, http.MethodPost, rentPath+"/charges", f.admin.access,
		map[string]any{"kind": "condominium", "amount": "400.00", "destination": "third_party"})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/charges", f.admin.access,
		map[string]any{"kind": "water", "amount": "10.00"})

	// More tax than rent is refused; then the payment, whose amount is the
	// rent, both charges and the late fee, less the tax: 2055.00.
	paidOn := start.AddDays(3).String()
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": paidOn, "late_fee": "35.00", "income_tax_withheld": "1600.01"})
	var rent rentBody
	a.expect(http.StatusOK, http.MethodPost, rentPath+"/payment", f.admin.access,
		map[string]any{"paid_on": paidOn, "late_fee": "35.00", "income_tax_withheld": "100.00"}).decode(t, &rent)
	if rent.AmountPaid == nil || *rent.AmountPaid != "2055.00" {
		t.Fatalf("amount received %+v", rent)
	}

	// The fee is 10% of the rent and the IPTU, 172.00. Maria has 70% of every
	// part; Bia, the last, the remainder.
	var maria, lima personLedger
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &maria)
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+bia.ID+"/ledger", f.admin.access, nil).decode(t, &lima)
	wantMaria := map[string]string{"rent": "1120.00", "late_fee": "24.50", "charge": "84.00", "admin_fee": "120.40", "income_tax": "70.00"}
	wantBia := map[string]string{"rent": "480.00", "late_fee": "10.50", "charge": "36.00", "admin_fee": "51.60", "income_tax": "30.00"}
	for who, got := range map[string]map[string]string{"maria": kindTotals(maria.Pending), "bia": kindTotals(lima.Pending)} {
		want := wantMaria
		if who == "bia" {
			want = wantBia
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s %s = %s, want %s", who, k, got[k], v)
			}
		}
	}
	if maria.Balance != "1038.10" || lima.Balance != "444.90" {
		t.Fatalf("balances %s and %s", maria.Balance, lima.Balance)
	}

	// A debit the office typed, and one deleted again.
	var debit ledgerLine
	a.expect(http.StatusCreated, http.MethodPost, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, map[string]any{
		"kind": "debit", "amount": "38.10", "description": "Conserto do chuveiro", "occurred_on": today.String(),
		"property_id": property.ID,
	}).decode(t, &debit)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, map[string]any{
		"kind": "rent", "amount": "1.00", "description": "x", "occurred_on": today.String(),
	})
	var credit ledgerLine
	a.expect(http.StatusCreated, http.MethodPost, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, map[string]any{
		"kind": "credit", "amount": "5.00", "description": "Engano", "occurred_on": today.String(),
	}).decode(t, &credit)
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/ledger/"+credit.ID, f.admin.access, nil)
	a.expect(http.StatusUnprocessableEntity, http.MethodDelete, "/v1/ledger/"+maria.Pending[0].ID, f.admin.access, nil)

	var balances struct {
		Balances []struct {
			Person struct {
				ID string `json:"id"`
			} `json:"person"`
			Pending string `json:"pending"`
		} `json:"balances"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts/balances", f.admin.access, nil).decode(t, &balances)
	if len(balances.Balances) != 2 {
		t.Fatalf("balances %+v", balances)
	}
	for _, b := range balances.Balances {
		if (b.Person.ID == f.owner.ID && b.Pending != "1000.00") || (b.Person.ID == bia.ID && b.Pending != "444.90") {
			t.Errorf("balance %+v", b)
		}
	}

	// Maria's payout closes everything she had.
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &maria)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": f.owner.ID, "paid_on": today.AddDays(1).String(), "entry_ids": lineIDs(maria.Pending),
	})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": bia.ID, "paid_on": today.String(), "entry_ids": lineIDs(maria.Pending),
	})
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": f.owner.ID, "paid_on": today.String(), "entry_ids": []string{debit.ID},
	})
	var payout payoutResponse
	a.expect(http.StatusCreated, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": f.owner.ID, "paid_on": today.String(), "entry_ids": lineIDs(maria.Pending), "method": "pix",
	}).decode(t, &payout)
	if payout.Total != "1000.00" || payout.Number != strings.TrimSpace(today.String()[:4])+"/0001" || len(payout.Entries) != 6 {
		t.Fatalf("payout %+v", payout)
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &maria)
	if maria.Balance != "0.00" || len(maria.Pending) != 0 {
		t.Errorf("after the payout %+v", maria)
	}

	// What a statement template is filled with: the payout, Maria field by
	// field, the totals, and the one property numbered.
	var fields struct {
		Fields []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"fields"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts/"+payout.ID+"/document-fields", f.admin.access, nil).decode(t, &fields)
	got := map[string]string{}
	for _, field := range fields.Fields {
		got[field.Name] = field.Value
	}
	for name, want := range map[string]string{
		"repasse_numero": payout.Number, "repasse_total": "R$ 1.000,00", "repasse_total_extenso": "mil reais",
		"repasse_forma": "PIX", "proprietario_nome": "Maria da Conceição", "proprietario_cpf": "529.982.247-25",
		"total_alugueis": "R$ 1.120,00", "total_taxa": "R$ 120,40", "total_debitos": "R$ 38,10",
		"imoveis_quantidade": "1", "imovel_1_liquido": "R$ 1.000,00", "imovel_1_irrf": "R$ 70,00",
		"imovel_2_endereco": "", "escritorio_nome": "Central",
	} {
		if got[name] != want {
			t.Errorf("field %s = %q, want %q", name, got[name], want)
		}
	}
	if len(fields.Fields) != 123 {
		t.Errorf("%d payout fields", len(fields.Fields))
	}
	// The same lines again: already closed.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
		"person_id": f.owner.ID, "paid_on": today.String(), "entry_ids": lineIDs(payout.Entries),
	})

	// Bia's payout, asked twice at once: one lands.
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		statuses []int
	)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := a.do(http.MethodPost, "/v1/payouts", f.admin.access, map[string]any{
				"person_id": bia.ID, "paid_on": today.String(), "entry_ids": lineIDs(lima.Pending),
			})
			mu.Lock()
			statuses = append(statuses, res.status)
			mu.Unlock()
		}()
	}
	wg.Wait()
	slices.Sort(statuses)
	if statuses[0] != http.StatusCreated || (statuses[1] != http.StatusConflict && statuses[1] != http.StatusUnprocessableEntity) {
		t.Errorf("concurrent payouts answered %v", statuses)
	}

	// The rent is in a payout, so its payment cannot be reversed, nor a
	// charge's destination changed.
	res := a.do(http.MethodDelete, rentPath+"/payment", f.admin.access, nil)
	if res.status != http.StatusUnprocessableEntity || !strings.Contains(string(res.body), payout.Number) {
		t.Errorf("reversing a paid-out rent = %d %s", res.status, res.body)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodPatch, rentPath+"/charges/"+rent.Charges[1].ID, f.admin.access,
		map[string]any{"destination": "owner"})

	var list struct {
		Payouts []payoutResponse `json:"payouts"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts", f.admin.access, nil).decode(t, &list)
	if len(list.Payouts) != 2 {
		t.Fatalf("payouts %+v", list)
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts?person_id="+bia.ID, f.admin.access, nil).decode(t, &list)
	if len(list.Payouts) != 1 || list.Payouts[0].Number != today.String()[:4]+"/0002" {
		t.Errorf("Bia's payouts %+v", list)
	}

	var d struct {
		Month struct {
			OfficeFee    string `json:"office_fee"`
			PaidOut      string `json:"paid_out"`
			PaidOutCount int    `json:"paid_out_count"`
		} `json:"month"`
		Payouts struct {
			Pending       string `json:"pending"`
			Beneficiaries int    `json:"beneficiaries"`
		} `json:"payouts"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/dashboard", f.admin.access, nil).decode(t, &d)
	if d.Month.PaidOut != "1444.90" || d.Month.PaidOutCount != 2 || d.Payouts.Pending != "0.00" || d.Payouts.Beneficiaries != 0 {
		t.Errorf("dashboard %+v", d)
	}

	// Another office sees none of it.
	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/payouts/"+payout.ID, other.access, nil)
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", other.access, nil)
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts/balances", other.access, nil).decode(t, &balances)
	if len(balances.Balances) != 0 {
		t.Errorf("another office sees balances %+v", balances)
	}

	// Undoing both payouts lets the payment go, and its lines with it; the
	// manual debit stays.
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/payouts/"+payout.ID, f.admin.access, nil)
	a.expect(http.StatusOK, http.MethodGet, "/v1/payouts?person_id="+bia.ID, f.admin.access, nil).decode(t, &list)
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/payouts/"+list.Payouts[0].ID, f.admin.access, nil)
	a.expect(http.StatusNotFound, http.MethodDelete, "/v1/payouts/"+payout.ID, f.admin.access, nil)

	// With nothing paid out, the condominium can become the owners': the
	// lines are written again, the fee now on 2120.00.
	a.expect(http.StatusOK, http.MethodPatch, rentPath+"/charges/"+rent.Charges[1].ID, f.admin.access,
		map[string]any{"destination": "owner"})
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+bia.ID+"/ledger", f.admin.access, nil).decode(t, &lima)
	if got := kindTotals(lima.Pending); got["admin_fee"] != "63.60" || got["charge"] != "156.00" {
		t.Errorf("after the destination changed %v", got)
	}

	a.expect(http.StatusOK, http.MethodDelete, rentPath+"/payment", f.admin.access, nil)
	a.expect(http.StatusOK, http.MethodGet, "/v1/people/"+f.owner.ID+"/ledger", f.admin.access, nil).decode(t, &maria)
	if len(maria.Pending) != 1 || maria.Pending[0].Kind != "debit" || maria.Balance != "-38.10" {
		t.Errorf("after the reversal %+v", maria)
	}
}

// A usufructuary leases alone: the contract carries the share, and without it
// the contract is refused, since nobody could tell who receives.
func TestLandlordWhoIsNotTheOwner(t *testing.T) {
	f := newLease(t)
	a := f.a
	caio := a.createPerson(f.admin, individual("Caio Usufrutuário"))
	parties := func(share any) []map[string]any {
		landlord := map[string]any{"person_id": caio.ID, "role": "landlord"}
		if share != nil {
			landlord["share"] = share
		}
		return []map[string]any{landlord, {"person_id": f.tenant.ID, "role": "tenant"}}
	}
	res := a.do(http.MethodPost, "/v1/contracts", f.admin.access,
		f.contract("U-1", "2031-01-01", "2031-12-31", "parties", parties(nil)))
	if res.status != http.StatusUnprocessableEntity || !strings.Contains(string(res.body), "parties[0].share") {
		t.Fatalf("a landlord without a share = %d %s", res.status, res.body)
	}
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/contracts", f.admin.access,
		f.contract("U-1", "2031-01-01", "2031-12-31", "parties", parties("60")))
	c := f.create(f.contract("U-1", "2031-01-01", "2031-12-31", "parties", parties("100")))

	var got struct {
		Parties []struct {
			Role  string  `json:"role"`
			Share *string `json:"share"`
		} `json:"parties"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+c.ID, f.admin.access, nil).decode(t, &got)
	if got.Parties[0].Share == nil || *got.Parties[0].Share != "100.00" {
		t.Errorf("landlord share %+v", got.Parties)
	}

	// The owner as landlord needs no share, and one sent is dropped.
	d := f.create(f.contract("U-2", "2033-01-01", "2033-12-31", "parties", []map[string]any{
		{"person_id": f.owner.ID, "role": "landlord", "share": "100"}, {"person_id": f.tenant.ID, "role": "tenant"},
	}))
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+d.ID, f.admin.access, nil).decode(t, &got)
	if got.Parties[0].Share != nil {
		t.Errorf("the owner kept a share %+v", got.Parties)
	}
}

// Who signs the receipts: absent until an administrator says, then read back
// formatted, the document sealed at rest.
func TestAdministrator(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	a.expect(http.StatusNoContent, http.MethodGet, "/v1/organization/administrator", admin.access, nil)

	a.expect(http.StatusUnprocessableEntity, http.MethodPut, "/v1/organization/administrator", admin.access,
		map[string]any{"kind": "individual", "document": "111.111.111-11", "creci": "12345-F"})
	a.expect(http.StatusUnprocessableEntity, http.MethodPut, "/v1/organization/administrator", admin.access,
		map[string]any{"kind": "person", "document": "529.982.247-25"})

	var got struct {
		Kind     string `json:"kind"`
		Document string `json:"document"`
		CRECI    string `json:"creci"`
	}
	a.expect(http.StatusOK, http.MethodPut, "/v1/organization/administrator", admin.access,
		map[string]any{"kind": "individual", "document": "52998224725", "creci": " CRECI 12345-F/SP "}).decode(t, &got)
	if got.Document != "529.982.247-25" || got.CRECI != "CRECI 12345-F/SP" {
		t.Errorf("stored %+v", got)
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/organization/administrator", admin.access, nil).decode(t, &got)
	if got.Kind != "individual" || got.Document != "529.982.247-25" {
		t.Errorf("read back %+v", got)
	}

	// Sealed at rest: the digits are nowhere in the row.
	var raw []byte
	if err := a.db.QueryRowForTest(t.Context(), `SELECT administrator_document FROM organizations`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "52998224725") {
		t.Error("the administrator's CPF is stored in the clear")
	}

	a.expect(http.StatusOK, http.MethodPut, "/v1/organization/administrator", admin.access,
		map[string]any{"kind": "company", "document": "12.ABC.345/01DE-35", "creci": "J-9999"}).decode(t, &got)
	if got.Document != "12.ABC.345/01DE-35" {
		t.Errorf("company %+v", got)
	}
}
