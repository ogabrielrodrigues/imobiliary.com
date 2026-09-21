package domain

import (
	"errors"
	"testing"
	"uuid"
)

func shares(rates ...Rate) []Beneficiary {
	out := make([]Beneficiary, len(rates))
	for i, r := range rates {
		out[i] = Beneficiary{PersonID: uuid.NewV7(), Share: r}
	}
	return out
}

func TestSplitAlwaysAddsUpExactly(t *testing.T) {
	cases := []struct {
		amount Money
		shares []Beneficiary
		want   []Money
	}{
		{150000, shares(FullShare), []Money{150000}},
		{150000, shares(500_000, 500_000), []Money{75000, 75000}},
		{1, shares(500_000, 500_000), []Money{0, 1}},
		{100, shares(333_333, 333_333, 333_334), []Money{33, 33, 34}},
		{100001, shares(700_000, 300_000), []Money{70000, 30001}},
		{MaxMoney, shares(1, 999_999), []Money{99_999_999, MaxMoney - 99_999_999}},
	}
	for _, c := range cases {
		got, err := Split(c.amount, c.shares)
		if err != nil {
			t.Fatalf("Split(%d): %v", c.amount, err)
		}
		var sum Money
		for i := range got {
			sum += got[i]
			if got[i] != c.want[i] || got[i] < 0 {
				t.Errorf("Split(%d) part %d = %d, want %d", c.amount, i, got[i], c.want[i])
			}
		}
		if sum != c.amount {
			t.Errorf("Split(%d) adds up to %d", c.amount, sum)
		}
	}
	if _, err := Split(-1, shares(FullShare)); err == nil {
		t.Error("a negative amount was split")
	}
	if _, err := Split(1, nil); err == nil {
		t.Error("an amount was split among nobody")
	}
}

func TestBeneficiaries(t *testing.T) {
	ana, bia, caio := uuid.NewV7(), uuid.NewV7(), uuid.NewV7()
	owners := []PropertyOwner{{PersonID: ana, Share: 700_000}, {PersonID: bia, Share: 300_000}}

	// The landlords are the owners, in another order: the property's shares,
	// in the landlords' order.
	got, err := Beneficiaries([]ContractParty{{PersonID: bia}, {PersonID: ana}}, owners)
	if err != nil || len(got) != 2 || got[0].PersonID != bia || got[0].Share != 300_000 || got[1].Share != 700_000 {
		t.Errorf("owners as landlords: %+v, %v", got, err)
	}

	// A usufructuary alone: the contract's share.
	full := FullShare
	got, err = Beneficiaries([]ContractParty{{PersonID: caio, Share: &full}}, owners)
	if err != nil || len(got) != 1 || got[0].PersonID != caio || got[0].Share != FullShare {
		t.Errorf("usufructuary: %+v, %v", got, err)
	}

	// One co-owner alone without a share recorded cannot be split.
	if _, err := Beneficiaries([]ContractParty{{PersonID: ana}}, owners); !errors.Is(err, ErrNoShares) {
		t.Errorf("co-owner without a share: %v", err)
	}

	tenant := ContractParty{PersonID: caio, Role: RoleTenant}
	v := &ValidationError{}
	ValidateLandlordShares(v, []ContractParty{tenant, {PersonID: ana, Role: RoleLandlord}}, owners)
	if err := v.OrNil(); err == nil || v.Fields[0].Field != "parties[1].share" {
		t.Errorf("a landlord who is not all the owners, without a share: %v", err)
	}
	v = &ValidationError{}
	ValidateLandlordShares(v, []ContractParty{{PersonID: ana, Role: RoleLandlord}, {PersonID: bia, Role: RoleLandlord}}, owners)
	if v.OrNil() != nil {
		t.Errorf("the owners as landlords needed shares: %v", v)
	}

	// Shares the owners' own make redundant are dropped, and so is one on a
	// tenant.
	parties := []ContractParty{{PersonID: ana, Role: RoleLandlord, Share: &full}, {PersonID: bia, Role: RoleLandlord, Share: &full}, {PersonID: caio, Role: RoleTenant, Share: &full}}
	NormalizeLandlordShares(parties, owners)
	for _, p := range parties {
		if p.Share != nil {
			t.Errorf("a share survived on %+v", p)
		}
	}
}

func receipt() *Receipt {
	return &Receipt{
		RentID: uuid.NewV7(), ContractID: uuid.NewV7(), PropertyID: uuid.NewV7(),
		Rent: 150000, LateFee: 16500, IncomeTax: 0, AdminFee: DefaultAdminFee,
		Charges: []Charge{
			{ID: uuid.NewV7(), Kind: ChargePropertyTax, Amount: 12000, Destination: DestinationOwner},
			{ID: uuid.NewV7(), Kind: ChargeCondominium, Amount: 40000, Destination: DestinationThirdParty},
		},
	}
}

func totals(entries []LedgerEntry) map[EntryKind]Money {
	out := map[EntryKind]Money{}
	for _, e := range entries {
		out[e.Kind] += e.Amount
	}
	return out
}

func TestReceiptEntries(t *testing.T) {
	r := receipt()
	// The fee is on the rent and the owner's charge only: 10% of 1620.00.
	if fee, _ := r.AdminFeeAmount(); fee != 16200 {
		t.Fatalf("fee = %d, want 16200", fee)
	}

	got, err := ReceiptEntries(r, shares(FullShare))
	if err != nil {
		t.Fatal(err)
	}
	sum := totals(got)
	want := map[EntryKind]Money{EntryRent: 150000, EntryLateFee: 16500, EntryCharge: 12000, EntryAdminFee: 16200}
	for k, v := range want {
		if sum[k] != v {
			t.Errorf("%s = %d, want %d", k, sum[k], v)
		}
	}
	if _, ok := sum[EntryIncomeTax]; ok {
		t.Error("a line was written for a tax of zero")
	}
	for _, e := range got {
		if e.Kind == EntryCharge && (e.ChargeID == nil || *e.ChargeID != r.Charges[0].ID) {
			t.Error("the owner's charge line does not name its charge")
		}
		if e.RentID == nil || *e.RentID != r.RentID {
			t.Error("a line does not name its rent")
		}
	}
	// The whole of the late fee is the owner's, and the balance is what the
	// tenant paid less the condominium passed on and the fee.
	if b := PayoutTotal(got); b != 150000+16500+12000-16200 {
		t.Errorf("balance = %d", b)
	}
}

func TestReceiptEntriesSplitEachComponent(t *testing.T) {
	r := receipt()
	r.Rent, r.LateFee, r.Charges, r.IncomeTax = 100001, 1, nil, 3
	s := shares(333_333, 333_333, 333_334)
	got, err := ReceiptEntries(r, s)
	if err != nil {
		t.Fatal(err)
	}
	sum := totals(got)
	fee, _ := r.AdminFeeAmount()
	if sum[EntryRent] != 100001 || sum[EntryLateFee] != 1 || sum[EntryIncomeTax] != 3 || sum[EntryAdminFee] != fee {
		t.Errorf("components do not add up: %v, fee %d", sum, fee)
	}
	for _, e := range got {
		if e.Amount <= 0 {
			t.Errorf("a line of %d was written", e.Amount)
		}
	}
}

func TestIncomeTaxIsDeducted(t *testing.T) {
	r := receipt()
	r.Charges, r.LateFee, r.IncomeTax = nil, 0, 11250
	got, err := ReceiptEntries(r, shares(FullShare))
	if err != nil {
		t.Fatal(err)
	}
	if b := PayoutTotal(got); b != 150000-15000-11250 {
		t.Errorf("balance = %d", b)
	}
}

func TestValidatePayout(t *testing.T) {
	today := mustDate(t, "2026-10-10")
	who := uuid.NewV7()
	line := func(kind EntryKind, amount Money, on string) LedgerEntry {
		return LedgerEntry{PersonID: who, Kind: kind, Amount: amount, OccurredOn: mustDate(t, on)}
	}
	p := &Payout{PersonID: who, PaidOn: today}

	if err := ValidatePayout(p, []LedgerEntry{line(EntryRent, 1000, "2026-10-05"), line(EntryAdminFee, 100, "2026-10-05")}, today); err != nil {
		t.Errorf("a valid payout was refused: %v", err)
	}
	if err := ValidatePayout(p, []LedgerEntry{line(EntryDebit, 1000, "2026-10-05")}, today); err == nil {
		t.Error("a payout below zero was accepted")
	}
	if err := ValidatePayout(p, []LedgerEntry{line(EntryRent, 1000, "2026-10-11")}, today); err == nil {
		t.Error("a line later than the payout was accepted")
	}
	other := line(EntryRent, 1000, "2026-10-05")
	other.PersonID = uuid.NewV7()
	if err := ValidatePayout(p, []LedgerEntry{other}, today); err == nil {
		t.Error("another person's line was accepted")
	}
	done := line(EntryRent, 1000, "2026-10-05")
	id := uuid.NewV7()
	done.PayoutID = &id
	if err := ValidatePayout(p, []LedgerEntry{done}, today); err == nil {
		t.Error("a line already paid out was accepted")
	}
	future := &Payout{PersonID: who, PaidOn: mustDate(t, "2026-10-11")}
	if err := ValidatePayout(future, []LedgerEntry{line(EntryRent, 1000, "2026-10-05")}, today); err == nil {
		t.Error("a payout in the future was accepted")
	}
	if (&Payout{Year: 2026, Sequence: 7}).Number() != "2026/0007" {
		t.Error("payout number")
	}
}

func TestValidateManualEntry(t *testing.T) {
	today := mustDate(t, "2026-10-10")
	ok := &LedgerEntry{Kind: EntryDebit, Amount: 25000, Description: "Conserto do chuveiro", OccurredOn: today}
	if err := ValidateManualEntry(ok, today); err != nil {
		t.Errorf("a valid debit was refused: %v", err)
	}
	for name, e := range map[string]*LedgerEntry{
		"rent kind":      {Kind: EntryRent, Amount: 1, Description: "x", OccurredOn: today},
		"no amount":      {Kind: EntryCredit, Description: "x", OccurredOn: today},
		"no description": {Kind: EntryCredit, Amount: 1, OccurredOn: today},
		"future":         {Kind: EntryCredit, Amount: 1, Description: "x", OccurredOn: mustDate(t, "2026-10-11")},
	} {
		if err := ValidateManualEntry(e, today); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
