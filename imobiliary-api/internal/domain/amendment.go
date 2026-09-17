package domain

import (
	"time"
	"uuid"
)

// NoticeAdjustmentPeriod: an adjustment less than twelve months after the
// start or the previous adjustment. Lei 10.192/2001, art. 2º, § 1º, voids an
// index clause with a shorter period. The office may still record it, as a
// negotiated change, once it acknowledges the notice.
const NoticeAdjustmentPeriod NoticeCode = "adjustment_period"

// Amendment is a change of rent from a day on: an index adjustment or a
// negotiated one. It records the rate for reference and the rent actually
// agreed, which the office may type over the suggestion.
type Amendment struct {
	ID         uuid.UUID
	ContractID uuid.UUID
	AmendedOn  Date
	// Index is the contract's index when the adjustment was recorded.
	Index        AdjustmentIndex
	IndexRate    Rate
	PreviousRent Money
	IndexedRent  Money
	// PeriodAcknowledgedBy and PeriodAcknowledgedAt record the acknowledgement
	// of NoticeAdjustmentPeriod, when it was raised.
	PeriodAcknowledgedBy *uuid.UUID
	PeriodAcknowledgedAt *time.Time
	CreatedAt            time.Time
}

// SuggestedRent is the rent an index rate points to: previous × (1 + rate).
// A negative rate never lowers the rent, as the plan settles; the rate is still
// recorded.
func SuggestedRent(previous Money, rate Rate) (Money, error) {
	if rate <= 0 {
		return previous, nil
	}
	return previous.Adjust(rate)
}

// ValidateAmendment checks an adjustment against its contract and the last
// adjustment recorded before it, nil when there is none.
func ValidateAmendment(c *Contract, last *Amendment, a *Amendment) error {
	v := &ValidationError{}
	switch {
	case c.TerminatedOn != nil:
		v.Add("amended_on", "a terminated contract cannot be adjusted")
	case a.AmendedOn.IsZero():
		v.Add("amended_on", "is required")
	case !a.AmendedOn.After(c.StartsOn):
		v.Add("amended_on", "must be after the start")
	case a.AmendedOn.After(c.ExpiresOn):
		v.Add("amended_on", "must not be after the expiry")
	case last != nil && !a.AmendedOn.After(last.AmendedOn):
		v.Add("amended_on", "must be after the last adjustment")
	}
	if a.IndexRate <= -RateScale || a.IndexRate > RateScale {
		v.Add("index_rate", "must be above -100 and at most 100")
	}
	if a.IndexedRent <= 0 || !a.IndexedRent.Valid() {
		v.Add("indexed_rent", "must be greater than zero")
	}
	return v.OrNil()
}

// AmendmentNotices lists the notices an adjustment raises.
func AmendmentNotices(c *Contract, last *Amendment, a *Amendment) []NoticeCode {
	reference := c.StartsOn
	if last != nil {
		reference = last.AmendedOn
	}
	if a.AmendedOn.Before(reference.AddMonths(12)) {
		return []NoticeCode{NoticeAdjustmentPeriod}
	}
	return nil
}

// FirstAdjustedSequence is the first instalment an adjustment from a day on
// changes: the first whose month starts on that day or later. A month already
// running keeps the rent it began with.
func FirstAdjustedSequence(c *Contract, on Date) int {
	n := 1
	for {
		from, _ := RentPeriod(c, n)
		if !from.Before(on) {
			return n
		}
		n++
	}
}

// PaidFrom reports whether any stored instalment from sequence on is paid:
// an adjustment or its undoing would change what a payment settled.
func PaidFrom(rents []TerminationRent, sequence int) bool {
	for _, r := range rents {
		if r.Sequence >= sequence && r.Paid {
			return true
		}
	}
	return false
}
