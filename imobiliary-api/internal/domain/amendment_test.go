package domain

import (
	"errors"
	"slices"
	"testing"
)

func TestSuggestedRent(t *testing.T) {
	for _, c := range []struct {
		rate Rate
		want Money
	}{
		{45_000, 156750},  // 4.5%
		{31_812, 154772},  // 3.1812%, half away from zero
		{0, 150000},       // no change
		{-31_812, 150000}, // a negative index never lowers the rent
	} {
		got, err := SuggestedRent(150000, c.rate)
		if err != nil || got != c.want {
			t.Errorf("SuggestedRent(150000, %s) = %d, %v; want %d", c.rate, got, err, c.want)
		}
	}
}

func TestValidateAmendment(t *testing.T) {
	c := validContract(t)
	good := &Amendment{AmendedOn: date(t, "2027-10-01"), IndexRate: 45_000, IndexedRent: 156750}
	if err := ValidateAmendment(c, nil, good); err != nil {
		t.Fatalf("a valid adjustment was refused: %v", err)
	}

	last := &Amendment{AmendedOn: date(t, "2027-10-01")}
	for name, tc := range map[string]struct {
		last  *Amendment
		edit  func(a *Amendment)
		field string
	}{
		"on the start":       {nil, func(a *Amendment) { a.AmendedOn = c.StartsOn }, "amended_on"},
		"after the expiry":   {nil, func(a *Amendment) { a.AmendedOn = date(t, "2029-10-01") }, "amended_on"},
		"not after the last": {last, func(a *Amendment) {}, "amended_on"},
		"rate of -100":       {nil, func(a *Amendment) { a.IndexRate = -RateScale }, "index_rate"},
		"no rent":            {nil, func(a *Amendment) { a.IndexedRent = 0 }, "indexed_rent"},
	} {
		t.Run(name, func(t *testing.T) {
			a := *good
			tc.edit(&a)
			var v *ValidationError
			if err := ValidateAmendment(c, tc.last, &a); !errors.As(err, &v) || v.Fields[0].Field != tc.field {
				t.Errorf("got %v, want an error on %s", err, tc.field)
			}
		})
	}

	ended := validContract(t)
	on := date(t, "2027-03-01")
	ended.TerminatedOn = &on
	if err := ValidateAmendment(ended, nil, good); err == nil {
		t.Error("a terminated contract was adjusted")
	}
}

func TestAmendmentNotices(t *testing.T) {
	c := validContract(t) // starts 2026-10-01
	at := func(s string) *Amendment { return &Amendment{AmendedOn: date(t, s)} }

	if got := AmendmentNotices(c, nil, at("2027-10-01")); len(got) != 0 {
		t.Errorf("twelve months after the start raised %v", got)
	}
	if got := AmendmentNotices(c, nil, at("2027-09-30")); !slices.Equal(got, []NoticeCode{NoticeAdjustmentPeriod}) {
		t.Errorf("a day short of twelve months raised %v", got)
	}
	// The period counts from the last adjustment once there is one.
	if got := AmendmentNotices(c, at("2027-10-01"), at("2028-06-01")); len(got) != 1 {
		t.Errorf("eight months after the last adjustment raised %v", got)
	}
}

func TestFirstAdjustedSequence(t *testing.T) {
	c := validContract(t) // months from the 1st, starting 2026-10-01
	for on, want := range map[string]int{
		"2027-10-01": 13, // the thirteenth month starts that day
		"2027-10-02": 14, // October is already running
		"2026-10-02": 2,
	} {
		if got := FirstAdjustedSequence(c, date(t, on)); got != want {
			t.Errorf("FirstAdjustedSequence(%s) = %d, want %d", on, got, want)
		}
	}
	rents := []TerminationRent{{12, 1, true}, {13, 1, false}}
	if PaidFrom(rents, 13) || !PaidFrom(rents, 12) {
		t.Error("PaidFrom misread the payments")
	}
}
