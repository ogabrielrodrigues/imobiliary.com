package domain

import (
	"errors"
	"testing"
)

func TestComputeLateFee(t *testing.T) {
	due := date(t, "2026-11-10")
	for _, c := range []struct {
		paidOn                   string
		days                     int
		penalty, interest, total Money
	}{
		{"2026-11-10", 0, 0, 0, 0},
		{"2026-11-01", 0, 0, 0, 0},
		// 10% of 1600.00, plus 1% a month for 5 of 30 days: 2.666... → 2.67.
		{"2026-11-15", 5, 16000, 267, 16267},
		// Thirty days is the whole monthly rate.
		{"2026-12-10", 30, 16000, 1600, 17600},
	} {
		got, err := ComputeLateFee(160000, due, date(t, c.paidOn), DefaultLatePenalty, DefaultLateInterest)
		if err != nil || got.DaysLate != c.days || got.Penalty != c.penalty || got.Interest != c.interest || got.Total != c.total {
			t.Errorf("paid %s: %+v, %v", c.paidOn, got, err)
		}
	}
}

func TestValidateCharge(t *testing.T) {
	good := &Charge{Kind: ChargeCondominium, Amount: 45000, Destination: DestinationThirdParty}
	if err := ValidateCharge(good); err != nil {
		t.Fatalf("a condominium charge was refused: %v", err)
	}
	for name, c := range map[string]Charge{
		"unknown kind":                {Kind: "garage", Amount: 1},
		"other without a description": {Kind: ChargeOther, Amount: 1},
		"no amount":                   {Kind: ChargeWater, Destination: DestinationThirdParty},
		"no destination":              {Kind: ChargeWater, Amount: 1},
	} {
		if err := ValidateCharge(&c); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	other := &Charge{Kind: ChargeOther, Description: "  Taxa de lixo ", Amount: 1500, Destination: DestinationOwner}
	NormalizeCharge(other)
	if err := ValidateCharge(other); err != nil || other.Description != "Taxa de lixo" {
		t.Errorf("another charge with a description: %v %q", err, other.Description)
	}
}

func TestValidatePayment(t *testing.T) {
	today := date(t, "2026-11-20")
	if err := ValidatePayment(&Payment{PaidOn: today, AmountPaid: 160000}, today); err != nil {
		t.Fatalf("a payment today was refused: %v", err)
	}
	var v *ValidationError
	err := ValidatePayment(&Payment{PaidOn: date(t, "2026-11-21"), LateFee: -1}, today)
	if !errors.As(err, &v) || len(v.Fields) != 3 {
		t.Errorf("a future, empty, negative payment gave %v", err)
	}
}
