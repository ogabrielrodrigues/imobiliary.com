package domain

import (
	"errors"
	"math/rand/v2"
	"testing"
)

func terms(t *testing.T, due Money, dueOn string) RentTerms {
	t.Helper()
	return RentTerms{Due: due, DueOn: date(t, dueOn), PenaltyRate: DefaultLatePenalty, InterestRate: DefaultLateInterest}
}

func moneyPtr(m Money) *Money { return &m }

// With no payment, the standing is exactly the late fee a payment in full
// always had: the partial rules change nothing for a rent paid at once.
func TestStandingWithoutPaymentsIsTheLateFee(t *testing.T) {
	rt := terms(t, 160000, "2026-11-10")
	for _, day := range []string{"2026-11-01", "2026-11-10", "2026-11-11", "2026-11-15", "2026-12-10", "2027-03-02"} {
		fee, err := ComputeLateFee(rt.Due, rt.DueOn, date(t, day), rt.PenaltyRate, rt.InterestRate)
		if err != nil {
			t.Fatal(err)
		}
		s, err := RentStanding(rt, nil, date(t, day))
		if err != nil {
			t.Fatal(err)
		}
		if s.Principal != rt.Due || s.Penalty != fee.Penalty || s.Interest != fee.Interest || s.DaysLate != fee.DaysLate {
			t.Errorf("%s: standing %+v, late fee %+v", day, s, fee)
		}
	}
}

func TestAPartialBeforeTheDueDayLowersThePenaltyBase(t *testing.T) {
	rt := terms(t, 160000, "2026-11-10")
	paid := []RentPayment{{PaidOn: date(t, "2026-11-08"), Amount: 60000, Principal: 60000}}
	s, err := RentStanding(rt, paid, date(t, "2026-11-15"))
	if err != nil {
		t.Fatal(err)
	}
	// 10% of the 1000.00 still open; 1% a month on it for 5 days: 1.666… → 1.67.
	if s.Principal != 100000 || s.Penalty != 10000 || s.Interest != 167 {
		t.Errorf("standing %+v", s)
	}
}

func TestAPartialSettlesInterestAndPenaltyFirst(t *testing.T) {
	rt := terms(t, 100000, "2026-11-10")
	on := date(t, "2026-11-20")
	s, err := RentStanding(rt, nil, on)
	if err != nil {
		t.Fatal(err)
	}
	// 100.00 of penalty, and 1% a month for 10 days: 3.33.
	if s.Penalty != 10000 || s.Interest != 333 {
		t.Fatalf("standing %+v", s)
	}
	p, err := PlanPayment(s, PaymentRequest{PaidOn: on, Amount: moneyPtr(50000)}, rt.Due, 0, on)
	if err != nil {
		t.Fatal(err)
	}
	if p.LateFee != 10333 || p.Principal != 39667 || p.Waived != 0 || p.Amount != 50000 {
		t.Fatalf("payment %+v", p)
	}

	// Interest keeps running on what is left, and the penalty is not charged
	// again: thirty days on 603.33 is 6.03.
	later, err := RentStanding(rt, []RentPayment{p}, date(t, "2026-12-20"))
	if err != nil {
		t.Fatal(err)
	}
	if later.Principal != 60333 || later.Penalty != 0 || later.Interest != 603 {
		t.Errorf("a month later %+v", later)
	}
}

func TestAPaymentBelowTheInterestLeavesThePrincipalAlone(t *testing.T) {
	rt := terms(t, 100000, "2026-11-10")
	on := date(t, "2026-11-20")
	s, _ := RentStanding(rt, nil, on)
	// A late fee of zero typed forgives it all, so even 2.00 reach the
	// principal.
	p, err := PlanPayment(s, PaymentRequest{PaidOn: on, Amount: moneyPtr(200), LateFee: moneyPtr(0)}, rt.Due, 0, on)
	if err != nil {
		t.Fatal(err)
	}
	if p.LateFee != 0 || p.Principal != 200 || p.Waived != 10333 {
		t.Fatalf("payment %+v", p)
	}

	// Left to the rule, 2.00 pay part of the interest and nothing else.
	p, err = PlanPayment(s, PaymentRequest{PaidOn: on, Amount: moneyPtr(200)}, rt.Due, 0, on)
	if err != nil {
		t.Fatal(err)
	}
	if p.LateFee != 200 || p.Principal != 0 || p.Waived != 0 {
		t.Fatalf("payment %+v", p)
	}
	after, _ := RentStanding(rt, []RentPayment{p}, on)
	if after.Interest != 133 || after.Penalty != 10000 || after.Principal != 100000 {
		t.Errorf("after %+v", after)
	}
}

func TestAForgivenLateFeeOnAPartial(t *testing.T) {
	rt := terms(t, 100000, "2026-11-10")
	on := date(t, "2026-11-20")
	s, _ := RentStanding(rt, nil, on)
	p, err := PlanPayment(s, PaymentRequest{PaidOn: on, Amount: moneyPtr(50000), LateFee: moneyPtr(0)}, rt.Due, 0, on)
	if err != nil {
		t.Fatal(err)
	}
	if p.Waived != 10333 || p.LateFee != 0 || p.Principal != 50000 {
		t.Fatalf("payment %+v", p)
	}
	after, _ := RentStanding(rt, []RentPayment{p}, on)
	if after.LateFee() != 0 || after.Principal != 50000 {
		t.Errorf("after %+v", after)
	}
}

func TestPayingEverythingSettlesTheRent(t *testing.T) {
	rt := terms(t, 100000, "2026-11-10")
	first := RentPayment{PaidOn: date(t, "2026-11-20"), Amount: 50000, LateFee: 10333, Principal: 39667}
	on := date(t, "2026-12-20")
	s, _ := RentStanding(rt, []RentPayment{first}, on)
	p, err := PlanPayment(s, PaymentRequest{PaidOn: on}, rt.Due, 0, on)
	if err != nil {
		t.Fatal(err)
	}
	if p.Principal != 60333 || p.LateFee != 603 || p.Amount != 60936 {
		t.Fatalf("payment %+v", p)
	}
	done, _ := RentStanding(rt, []RentPayment{first, p}, date(t, "2027-02-01"))
	if !done.Settled() || done.Total() != 0 {
		t.Errorf("after paying all %+v", done)
	}
	if _, err := PlanPayment(done, PaymentRequest{PaidOn: on}, rt.Due, 0, on); !hasField(err, "payment") {
		t.Errorf("paying a paid rent: %v", err)
	}
}

func TestPlanPaymentRefusals(t *testing.T) {
	rt := terms(t, 100000, "2026-11-10")
	today := date(t, "2026-11-10")
	s, _ := RentStanding(rt, nil, today)
	for field, req := range map[string]PaymentRequest{
		"paid_on":             {PaidOn: date(t, "2026-11-11")},
		"amount":              {PaidOn: today, Amount: moneyPtr(100001)},
		"late_fee":            {PaidOn: today, LateFee: moneyPtr(1)},
		"income_tax_withheld": {PaidOn: today, IncomeTax: 90001},
	} {
		if _, err := PlanPayment(s, req, rt.Due, 10000, today); !hasField(err, field) {
			t.Errorf("%s: %v", field, err)
		}
	}
	// The whole rent with the tax withheld is received as the rest.
	p, err := PlanPayment(s, PaymentRequest{PaidOn: today, IncomeTax: 1500}, rt.Due, 0, today)
	if err != nil || p.Amount != 98500 || p.Principal != 100000 {
		t.Errorf("with tax withheld: %+v, %v", p, err)
	}
}

func hasField(err error, field string) bool {
	var v *ValidationError
	if !errors.As(err, &v) {
		return false
	}
	for _, f := range v.Fields {
		if f.Field == field {
			return true
		}
	}
	return false
}

func TestPrincipalPartsAddUpAndNeverOverpay(t *testing.T) {
	parts, err := PrincipalParts(39667, []Money{80000, 15000, 5000}, []Money{0, 0, 0})
	if err != nil {
		t.Fatal(err)
	}
	// 80%, 15% and 5% of 396.67, rounded down, the centavo left on the rent.
	if parts[0] != 31734 || parts[1] != 5950 || parts[2] != 1983 {
		t.Errorf("parts %v", parts)
	}

	r := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		n := 1 + r.IntN(4)
		totals := make([]Money, n)
		var total Money
		for i := range totals {
			totals[i] = Money(1 + r.IntN(200000))
			total += totals[i]
		}
		paid := make([]Money, n)
		var settled Money
		for settled < total {
			amount := min(total-settled, Money(1+r.IntN(int(total))))
			if r.IntN(3) == 0 {
				amount = min(total-settled, Money(1+r.IntN(5)))
			}
			parts, err := PrincipalParts(amount, totals, paid)
			if err != nil {
				t.Fatal(err)
			}
			var sum Money
			for i, p := range parts {
				if p < 0 || paid[i]+p > totals[i] {
					t.Fatalf("part %d of %v overpays %v after %v", i, parts, totals, paid)
				}
				paid[i] += p
				sum += p
			}
			if sum != amount {
				t.Fatalf("parts %v add up to %d, not %d", parts, sum, amount)
			}
			settled += amount
		}
		for i := range totals {
			if paid[i] != totals[i] {
				t.Fatalf("settled %v, totals %v", paid, totals)
			}
		}
	}
	if _, err := PrincipalParts(2, []Money{1}, []Money{0}); !errors.Is(err, ErrOutOfRange) {
		t.Errorf("more than open: %v", err)
	}
}
