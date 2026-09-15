package domain

import (
	"strconv"
	"strings"
)

// RateScale is how many units of a Rate make a whole: a Rate is held in
// millionths, so 1_000_000 is 100%.
const RateScale = 1_000_000

// MaxRate bounds a rate in either direction at 1000%. No administration fee,
// penalty or price index comes near it, and the bound keeps every product
// with an amount far from overflow.
const MaxRate Rate = 10_000_000

// Rate is a proportion in millionths: 10% is 100000 and an index of -3,1812%
// is -31812. Written as a percentage it therefore carries up to four decimal
// places, which is more than any published Brazilian index uses.
type Rate int32

// Common rates.
const (
	// DefaultAdminFee is the administration fee a contract starts with.
	DefaultAdminFee Rate = 100_000
)

// ParseRate reads a percentage with up to four decimal places and an optional
// leading minus sign: "10", "10.5", "-3.1812". Commas, a plus sign, a percent
// sign and surrounding spaces are all rejected.
func ParseRate(s string) (Rate, error) {
	negative := strings.HasPrefix(s, "-")
	if negative {
		s = s[1:]
	}
	whole, fraction, hasDot := strings.Cut(s, ".")
	if !allDigits(whole) || (len(whole) > 1 && whole[0] == '0') {
		return 0, ErrInvalidRate
	}
	if hasDot && (!allDigits(fraction) || len(fraction) > 4) {
		return 0, ErrInvalidRate
	}
	if len(whole) > 4 {
		return 0, ErrOutOfRange
	}

	fraction += strings.Repeat("0", 4-len(fraction))
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, ErrInvalidRate
	}
	f, err := strconv.ParseInt(fraction, 10, 64)
	if err != nil {
		return 0, ErrInvalidRate
	}

	// A percentage with four decimals is already in millionths of a unit:
	// 3.1812% = 0.031812 = 31812 / 1_000_000.
	v := w*10_000 + f
	if negative {
		v = -v
	}
	if v > int64(MaxRate) || v < -int64(MaxRate) {
		return 0, ErrOutOfRange
	}
	return Rate(v), nil
}

// String writes the rate as a percentage with at least two and at most four
// decimal places: "10.00", "2.50", "-3.1812".
func (r Rate) String() string {
	v := int64(r)
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	fraction := strconv.FormatInt(v%10_000+10_000, 10)[1:]
	fraction = strings.TrimRight(fraction, "0")
	for len(fraction) < 2 {
		fraction += "0"
	}
	return sign + strconv.FormatInt(v/10_000, 10) + "." + fraction
}

// MarshalText makes a rate a JSON string.
func (r Rate) MarshalText() ([]byte, error) { return []byte(r.String()), nil }

// UnmarshalText reads a JSON string with ParseRate.
func (r *Rate) UnmarshalText(b []byte) error {
	v, err := ParseRate(string(b))
	if err != nil {
		return err
	}
	*r = v
	return nil
}
