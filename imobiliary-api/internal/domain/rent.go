package domain

import (
	"slices"
	"strings"
	"unicode/utf8"
	"uuid"
)

// ChargeKind is what an extra charge on a rent pays for.
type ChargeKind string

const (
	ChargeCondominium ChargeKind = "condominium"
	ChargePropertyTax ChargeKind = "property_tax" // IPTU
	ChargeWater       ChargeKind = "water"
	ChargeEnergy      ChargeKind = "energy"
	ChargeOther       ChargeKind = "other"
)

var chargeKinds = []ChargeKind{ChargeCondominium, ChargePropertyTax, ChargeWater, ChargeEnergy, ChargeOther}

// ChargeDestination is where a charge's money goes once the tenant pays it.
type ChargeDestination string

const (
	// DestinationOwner: the charge is the owner's, such as an IPTU in the
	// owner's name, and enters the payout. The administration fee is charged
	// on it too.
	DestinationOwner ChargeDestination = "owner"
	// DestinationThirdParty: the office pays it on, to the condominium or the
	// utility, and it never reaches the owner or pays a fee.
	DestinationThirdParty ChargeDestination = "third_party"
)

// SuggestedDestination is what a new charge of a kind usually is: the
// property tax is the owner's, the rest is paid on to a third party. The
// office changes it at will.
func SuggestedDestination(k ChargeKind) ChargeDestination {
	if k == ChargePropertyTax {
		return DestinationOwner
	}
	return DestinationThirdParty
}

// Charge is an amount billed with a rent besides the rent itself.
type Charge struct {
	ID          uuid.UUID
	RentID      uuid.UUID
	Kind        ChargeKind
	Description string
	Amount      Money
	Destination ChargeDestination
}

// MaxChargesPerRent bounds the list a rent carries.
const MaxChargesPerRent = 20

// NormalizeCharge trims the description.
func NormalizeCharge(c *Charge) {
	c.Description = strings.TrimSpace(c.Description)
}

// ValidateCharge checks a charge. "Other" needs a description saying what it is.
func ValidateCharge(c *Charge) error {
	v := &ValidationError{}
	if !slices.Contains(chargeKinds, c.Kind) {
		v.Add("kind", "is not a known charge")
	}
	switch {
	case c.Kind == ChargeOther && c.Description == "":
		v.Add("description", "is required for another charge")
	case utf8.RuneCountInString(c.Description) > 120:
		v.Add("description", "must be at most 120 characters")
	}
	if c.Amount <= 0 || !c.Amount.Valid() {
		v.Add("amount", "must be greater than zero")
	}
	if c.Destination != DestinationOwner && c.Destination != DestinationThirdParty {
		v.Add("destination", "must be owner or third_party")
	}
	return v.OrNil()
}

// DaysInInterestMonth is the month late interest is prorated over: the
// commercial month of thirty days, so a day late costs the same in February
// as in March.
const DaysInInterestMonth = 30

// LateFee is what a payment after the due day adds, as PLANO.md §3.8 settles:
// the penalty rate on the amount due, plus the monthly interest rate prorated
// by day over the same amount. The amount due is the rent with its charges.
// Paying on or before the due day adds nothing. Each part is rounded half away
// from zero to the centavo.
type LateFee struct {
	DaysLate int
	Penalty  Money
	Interest Money
	Total    Money
}

// ComputeLateFee is the suggested late fee for paying due on paidOn.
func ComputeLateFee(due Money, dueOn, paidOn Date, penaltyRate, interestRate Rate) (LateFee, error) {
	days := dueOn.DaysUntil(paidOn)
	if days <= 0 {
		return LateFee{}, nil
	}
	penalty, err := due.Portion(penaltyRate)
	if err != nil {
		return LateFee{}, err
	}
	v, ok := mulDivRound(int64(due), int64(interestRate)*int64(days), RateScale*DaysInInterestMonth)
	if !ok || !Money(v).Valid() {
		return LateFee{}, ErrOutOfRange
	}
	total, err := penalty.Add(Money(v))
	if err != nil {
		return LateFee{}, err
	}
	return LateFee{DaysLate: days, Penalty: penalty, Interest: Money(v), Total: total}, nil
}

// Payment is a rent received in full. LateFee is recorded as agreed; a
// discount is given there. IncomeTax is what a company tenant withheld.
// AmountPaid is what came in, computed rather than typed since payouts exist
// (user's decision, 2026-09-21): every centavo received has to come from
// somewhere the owner's ledger can show.
type Payment struct {
	PaidOn     Date
	AmountPaid Money
	LateFee    Money
	IncomeTax  Money
}

// AmountReceived is what a payment brings in: the rent with its charges and
// the late fee, less the tax the tenant withheld.
func AmountReceived(due, lateFee, incomeTax Money) (Money, error) {
	total, err := due.Add(lateFee)
	if err != nil {
		return 0, err
	}
	if incomeTax > total {
		return 0, ErrOutOfRange
	}
	return total - incomeTax, nil
}

// ValidatePayment checks a payment against today, where the office is.
func ValidatePayment(p *Payment, today Date) error {
	v := &ValidationError{}
	switch {
	case p.PaidOn.IsZero():
		v.Add("paid_on", "is required")
	case p.PaidOn.After(today):
		v.Add("paid_on", "must not be in the future")
	}
	if p.AmountPaid <= 0 || !p.AmountPaid.Valid() {
		v.Add("amount_paid", "must be greater than zero")
	}
	if p.LateFee < 0 || !p.LateFee.Valid() {
		v.Add("late_fee", "must not be negative")
	}
	return v.OrNil()
}
