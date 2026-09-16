package domain

import (
	"slices"
	"testing"
	"uuid"
)

func date(t *testing.T, s string) Date {
	t.Helper()
	d, err := ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func validContract(t *testing.T) *Contract {
	t.Helper()
	return &Contract{
		ID:               uuid.NewV7(),
		PropertyID:       uuid.NewV7(),
		Registry:         " 2026/ 001 ",
		GuaranteeKind:    GuaranteeNone,
		Rent:             150000,
		CurrentRent:      150000,
		AdminFee:         DefaultAdminFee,
		LatePenaltyRate:  DefaultLatePenalty,
		LateInterestRate: DefaultLateInterest,
		AdjustmentIndex:  "IGPM",
		SignedOn:         date(t, "2026-09-10"),
		StartsOn:         date(t, "2026-10-01"),
		ExpiresOn:        date(t, "2029-09-30"),
		Parties: []ContractParty{
			{PersonID: uuid.NewV7(), Role: RoleLandlord},
			{PersonID: uuid.NewV7(), Role: RoleTenant},
		},
	}
}

func TestTermMonths(t *testing.T) {
	for _, c := range []struct {
		starts, expires string
		want            int
	}{
		{"2026-10-01", "2029-09-30", 36},
		{"2026-10-01", "2029-10-01", 36},
		{"2026-10-01", "2029-10-02", 37},
		{"2026-01-31", "2026-02-28", 1},
		{"2026-10-15", "2027-04-14", 6},
		{"2026-10-01", "2026-10-20", 1},
	} {
		if got := TermMonths(date(t, c.starts), date(t, c.expires)); got != c.want {
			t.Errorf("TermMonths(%s, %s) = %d, want %d", c.starts, c.expires, got, c.want)
		}
	}
}

func TestScheduleFollowsTheDueDay(t *testing.T) {
	c := validContract(t)
	c.StartsOn, c.ExpiresOn, c.DueDay = date(t, "2027-12-20"), date(t, "2028-04-19"), 31
	got := Schedule(c)

	want := []string{"2027-12-20", "2028-01-31", "2028-02-29", "2028-03-31"}
	if len(got) != len(want) {
		t.Fatalf("%d instalments, want %d", len(got), len(want))
	}
	for i, inst := range got {
		if inst.DueOn.String() != want[i] || inst.Sequence != i+1 || inst.Amount != c.CurrentRent {
			t.Errorf("instalment %d = %+v, want due %s", i+1, inst, want[i])
		}
	}
	// A non-leap February clamps to the 28th.
	c.StartsOn, c.ExpiresOn = date(t, "2026-01-10"), date(t, "2026-03-09")
	if due := Schedule(c)[1].DueOn.String(); due != "2026-02-28" {
		t.Errorf("February instalment due %s", due)
	}
}

func TestValidContractIsNormalised(t *testing.T) {
	c := validContract(t)
	NormalizeContract(c)
	if err := ValidateContract(c); err != nil {
		t.Fatalf("a valid contract was refused: %v", err)
	}
	if c.Registry != "2026/ 001" || c.DueDay != 10 || c.AdjustmentIndex != "igpm" {
		t.Errorf("registry %q, due day %d, index %q", c.Registry, c.DueDay, c.AdjustmentIndex)
	}
}

func TestValidateContractRefuses(t *testing.T) {
	guarantor := ContractParty{PersonID: uuid.NewV7(), Role: RoleGuarantor}
	cases := []struct {
		name   string
		change func(*Contract)
		field  string
	}{
		{"no registry", func(c *Contract) { c.Registry = "" }, "registry"},
		{"no rent", func(c *Contract) { c.Rent = 0 }, "rent"},
		{"expiry before start", func(c *Contract) { c.ExpiresOn = c.StartsOn.AddDays(-1) }, "expires_on"},
		{"a due day of 32", func(c *Contract) { c.DueDay = 32 }, "due_day"},
		{"an unknown index", func(c *Contract) { c.AdjustmentIndex = "selic" }, "adjustment_index"},
		{"a deposit without an amount", func(c *Contract) { c.GuaranteeKind = GuaranteeDeposit }, "deposit_amount"},
		{"an amount without a deposit", func(c *Contract) { c.DepositAmount = 1000 }, "deposit_amount"},
		{"no tenant", func(c *Contract) { c.Parties = c.Parties[:1] }, "parties"},
		{"surety without a guarantor", func(c *Contract) { c.GuaranteeKind = GuaranteeSurety }, "parties"},
		{"a guarantor without surety", func(c *Contract) { c.Parties = append(c.Parties, guarantor) }, "parties"},
		{"the tenant as guarantor", func(c *Contract) {
			c.GuaranteeKind = GuaranteeSurety
			c.Parties = append(c.Parties, ContractParty{PersonID: c.Parties[1].PersonID, Role: RoleGuarantor})
		}, "parties"},
		{"the landlord as tenant", func(c *Contract) {
			c.Parties = append(c.Parties, ContractParty{PersonID: c.Parties[0].PersonID, Role: RoleTenant})
		}, "parties"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validContract(t)
			tc.change(c)
			NormalizeContract(c)
			if fields := fieldsOf(t, ValidateContract(c)); !slices.Contains(fields, tc.field) {
				t.Errorf("fields %v do not include %s", fields, tc.field)
			}
		})
	}
}

func TestNotices(t *testing.T) {
	spouse := uuid.NewV7()
	guarantor := uuid.NewV7()
	married := PartyPerson{MaritalStatus: MaritalMarried, PropertyRegime: RegimePartialCommunity, SpouseID: &spouse}

	c := validContract(t)
	if got := Notices(c, nil); len(got) != 0 {
		t.Errorf("no guarantee raised %v", got)
	}

	c.GuaranteeKind = GuaranteeSurety
	c.Parties = append(c.Parties, ContractParty{PersonID: guarantor, Role: RoleGuarantor})
	people := map[uuid.UUID]PartyPerson{guarantor: married}
	if got := Notices(c, people); !slices.Equal(got, []NoticeCode{NoticeAdvanceRent, NoticeGuarantorSpouseConsent}) {
		t.Errorf("a married guarantor alone raised %v", got)
	}

	c.Parties = append(c.Parties, ContractParty{PersonID: spouse, Role: RoleGuarantorSpouse})
	if got := Notices(c, people); !slices.Equal(got, []NoticeCode{NoticeAdvanceRent}) {
		t.Errorf("with the spouse consenting %v", got)
	}

	separate := married
	separate.PropertyRegime = RegimeTotalSeparation
	c.Parties = c.Parties[:3]
	if got := Notices(c, map[uuid.UUID]PartyPerson{guarantor: separate}); slices.Contains(got, NoticeGuarantorSpouseConsent) {
		t.Errorf("absolute separation still raised %v", got)
	}

	d := validContract(t)
	d.GuaranteeKind, d.DepositAmount = GuaranteeDeposit, 3*d.Rent
	if got := Notices(d, nil); slices.Contains(got, NoticeDepositLimit) {
		t.Errorf("three months' deposit raised %v", got)
	}
	d.DepositAmount++
	if got := Notices(d, nil); !slices.Contains(got, NoticeDepositLimit) {
		t.Errorf("more than three months' deposit raised %v", got)
	}

	err := MissingAcknowledgements([]NoticeCode{NoticeAdvanceRent, NoticeDepositLimit}, []NoticeCode{NoticeAdvanceRent})
	if messages := messagesOf(t, err); !slices.Equal(messages, []string{"deposit_limit"}) {
		t.Errorf("missing acknowledgements %v", messages)
	}
}

func TestStatusAndTermination(t *testing.T) {
	c := validContract(t)
	for day, want := range map[string]ContractStatus{
		"2026-09-30": ContractUpcoming, "2026-10-01": ContractActive,
		"2029-09-30": ContractActive, "2029-10-01": ContractExpired,
	} {
		if got := c.StatusOn(date(t, day)); got != want {
			t.Errorf("status on %s = %s, want %s", day, got, want)
		}
	}
	if err := ValidateTermination(c, date(t, "2026-09-01")); err == nil {
		t.Error("a termination before the start was accepted")
	}
	on := date(t, "2027-03-15")
	if err := ValidateTermination(c, on); err != nil {
		t.Fatal(err)
	}
	c.TerminatedOn = &on
	if c.StatusOn(date(t, "2026-11-01")) != ContractTerminated || ValidateTermination(c, on) == nil {
		t.Error("a terminated contract is not treated as one")
	}
}

func messagesOf(t *testing.T, err error) []string {
	t.Helper()
	var out []string
	for _, f := range err.(*ValidationError).Fields {
		out = append(out, f.Message)
	}
	return out
}
