package domain

import (
	"math/bits"
	"slices"
	"time"
	"uuid"
)

// Partial payments (PLANO-PENDENCIAS.md §2). A rent is paid by one payment or
// several. Each settles, in this order, the interest accrued, then the
// penalty, then the principal: the rent with its charges (Código Civil art.
// 354). Interest keeps running on the principal still open; the penalty is
// charged once, on the principal open the day after the due day. Neither earns
// interest of its own.

// RentPayment is money received for a rent on a day. Amount is what came in;
// IncomeTax is what a company tenant withheld on the owner's behalf, so the
// payment settles Amount + IncomeTax: LateFee of interest and penalty, then
// Principal. Waived is the part of the interest and penalty due that day the
// office forgave with this payment.
type RentPayment struct {
	ID        uuid.UUID
	RentID    uuid.UUID
	PaidOn    Date
	Amount    Money
	LateFee   Money
	Waived    Money
	Principal Money
	IncomeTax Money
	CreatedBy *uuid.UUID
	CreatedAt time.Time
}

// Settled is what the payment settles: what came in and what was withheld.
func (p *RentPayment) Settled() Money { return p.LateFee + p.Principal }

// RentTerms is what a rent's standing is computed from.
type RentTerms struct {
	// Due is the principal: the rent with its charges.
	Due          Money
	DueOn        Date
	PenaltyRate  Rate
	InterestRate Rate
}

// Standing is what a rent owes on a day.
type Standing struct {
	On        Date
	Principal Money
	// Interest and Penalty are accrued and still unpaid.
	Interest Money
	Penalty  Money
	DaysLate int
}

// LateFee is the interest and penalty owed.
func (s Standing) LateFee() Money { return s.Interest + s.Penalty }

// Total is everything owed.
func (s Standing) Total() Money { return s.Principal + s.Interest + s.Penalty }

// Settled reports whether nothing is left. Principal is settled last, so an
// open principal of zero means the rent is paid.
func (s Standing) Settled() bool { return s.Principal == 0 }

// interestOn is the interest on principal over days, the monthly rate
// prorated over the thirty-day commercial month, half away from zero.
func interestOn(principal Money, rate Rate, days int) (Money, error) {
	if days <= 0 || principal == 0 {
		return 0, nil
	}
	v, ok := mulDivRound(int64(principal), int64(rate)*int64(days), RateScale*DaysInInterestMonth)
	if !ok || !Money(v).Valid() {
		return 0, ErrOutOfRange
	}
	return Money(v), nil
}

// RentStanding replays the payments, in order, up to the day on and answers
// what is owed then. Payments after on are ignored.
func RentStanding(t RentTerms, payments []RentPayment, on Date) (Standing, error) {
	ordered := slices.Clone(payments)
	slices.SortStableFunc(ordered, func(a, b RentPayment) int { return a.PaidOn.Compare(b.PaidOn) })

	s := Standing{Principal: t.Due}
	penalized := false
	// accrued is the day interest has been counted to.
	accrued := t.DueOn
	advance := func(day Date) error {
		if !day.After(t.DueOn) || s.Principal == 0 {
			if day.After(accrued) {
				accrued = day
			}
			return nil
		}
		if !penalized {
			penalty, err := s.Principal.Portion(t.PenaltyRate)
			if err != nil {
				return err
			}
			s.Penalty += penalty
			penalized = true
		}
		interest, err := interestOn(s.Principal, t.InterestRate, accrued.DaysUntil(day))
		if err != nil {
			return err
		}
		s.Interest += interest
		accrued = day
		return nil
	}

	for _, p := range ordered {
		if p.PaidOn.After(on) {
			break
		}
		if err := advance(p.PaidOn); err != nil {
			return Standing{}, err
		}
		// Paid and forgiven, interest first, then the penalty.
		cleared := p.LateFee + p.Waived
		take := min(cleared, s.Interest)
		s.Interest -= take
		cleared -= take
		take = min(cleared, s.Penalty)
		s.Penalty -= take
		if p.Principal > s.Principal {
			return Standing{}, ErrOutOfRange
		}
		s.Principal -= p.Principal
		if s.Principal == 0 {
			// Nothing open earns interest, and a payment that closes the
			// principal closed whatever it did not pay by forgiving it.
			s.Interest, s.Penalty = 0, 0
		}
	}
	if err := advance(on); err != nil {
		return Standing{}, err
	}
	s.On = on
	if on.After(t.DueOn) {
		s.DaysLate = t.DueOn.DaysUntil(on)
	}
	return s, nil
}

// PaymentRequest is a payment as the office asks for it.
type PaymentRequest struct {
	PaidOn Date
	// Amount received; nil settles everything owed on the day.
	Amount *Money
	// LateFee is the interest and penalty charged on this payment; nil charges
	// what is owed. Less than owed forgives the difference.
	LateFee   *Money
	IncomeTax Money
}

// PlanPayment turns a request into a payment against the standing on its day.
// withheld is the tax already withheld by earlier payments, and rent the
// rent's own amount, which bounds all of it together.
func PlanPayment(s Standing, req PaymentRequest, rent, withheld Money, today Date) (RentPayment, error) {
	v := &ValidationError{}
	switch {
	case req.PaidOn.IsZero():
		v.Add("paid_on", "is required")
	case req.PaidOn.After(today):
		v.Add("paid_on", "must not be in the future")
	}
	if s.Settled() {
		v.Add("payment", "the rent is paid")
	}
	owed := s.LateFee()
	charged := owed
	if req.LateFee != nil {
		switch {
		case *req.LateFee < 0 || !req.LateFee.Valid():
			v.Add("late_fee", "must not be negative")
		case *req.LateFee > owed:
			v.Addf("late_fee", "must be at most %s, the interest and penalty owed", owed.String())
		default:
			charged = *req.LateFee
		}
	}
	if req.IncomeTax < 0 || !req.IncomeTax.Valid() {
		v.Add("income_tax_withheld", "must not be negative")
	} else if withheld+req.IncomeTax > rent {
		v.Add("income_tax_withheld", "must not exceed the rent")
	}
	if req.Amount != nil && (*req.Amount <= 0 || !req.Amount.Valid()) {
		v.Add("amount", "must be greater than zero")
	}
	if err := v.OrNil(); err != nil {
		return RentPayment{}, err
	}

	p := RentPayment{PaidOn: req.PaidOn, Waived: owed - charged, IncomeTax: req.IncomeTax}
	if req.Amount == nil {
		p.LateFee, p.Principal = charged, s.Principal
		if req.IncomeTax > p.Settled() {
			v.Add("income_tax_withheld", "must not exceed what the payment settles")
			return RentPayment{}, v
		}
		p.Amount = p.Settled() - req.IncomeTax
		return p, nil
	}

	settles, err := req.Amount.Add(req.IncomeTax)
	if err != nil {
		return RentPayment{}, err
	}
	p.Amount = *req.Amount
	p.LateFee = min(settles, charged)
	p.Principal = settles - p.LateFee
	if p.Principal > s.Principal {
		v.Addf("amount", "must be at most %s, what is owed", (s.Principal + charged - req.IncomeTax).String())
		return RentPayment{}, v
	}
	if p.LateFee < charged {
		// Too little to cover the interest and penalty: nothing is forgiven
		// yet, whatever the office typed, since the principal is untouched.
		p.Waived = 0
	}
	return p, nil
}

// PrincipalParts divides a payment's principal among the rent and its
// charges, in proportion to what each still has open, with each part rounded
// down and the remainder given to the rent first, then to the charges in
// order, never beyond what each has open. paid are the parts earlier payments
// settled, in the same order: the rent, then the charges.
func PrincipalParts(amount Money, totals, paid []Money) ([]Money, error) {
	if len(totals) != len(paid) || len(totals) == 0 {
		return nil, ErrOutOfRange
	}
	open := make([]Money, len(totals))
	var remaining Money
	for i := range totals {
		if paid[i] > totals[i] {
			return nil, ErrOutOfRange
		}
		open[i] = totals[i] - paid[i]
		remaining += open[i]
	}
	if amount < 0 || amount > remaining {
		return nil, ErrOutOfRange
	}
	parts := make([]Money, len(totals))
	if amount == 0 {
		return parts, nil
	}
	var given Money
	for i := range open {
		// amount and open[i] are both at most remaining, so the quotient
		// fits and Div64 cannot panic.
		hi, lo := bits.Mul64(uint64(amount), uint64(open[i]))
		q, _ := bits.Div64(hi, lo, uint64(remaining))
		part := Money(q)
		parts[i] = part
		given += part
	}
	for i := 0; given < amount; i++ {
		room := open[i] - parts[i]
		add := min(room, amount-given)
		parts[i] += add
		given += add
	}
	return parts, nil
}

// PaymentReceipts replays a rent's payments, in the order given, and answers
// for each the receipt the ledger is written from: the parts of the rent and
// of each charge that payment settled, its late fee and its tax. base carries
// the whole rent and charges, and what every receipt shares.
func PaymentReceipts(base Receipt, payments []RentPayment) ([]Receipt, error) {
	totals := make([]Money, 1+len(base.Charges))
	totals[0] = base.Rent
	for i, c := range base.Charges {
		totals[i+1] = c.Amount
	}
	paid := make([]Money, len(totals))
	out := make([]Receipt, 0, len(payments))
	for _, p := range payments {
		parts, err := PrincipalParts(p.Principal, totals, paid)
		if err != nil {
			return nil, err
		}
		r := base
		r.PaymentID, r.PaidOn, r.LateFee, r.IncomeTax = p.ID, p.PaidOn, p.LateFee, p.IncomeTax
		r.Rent = parts[0]
		r.Charges = slices.Clone(base.Charges)
		for i := range r.Charges {
			r.Charges[i].Amount = parts[i+1]
		}
		for i := range paid {
			paid[i] += parts[i]
		}
		out = append(out, r)
	}
	return out, nil
}
