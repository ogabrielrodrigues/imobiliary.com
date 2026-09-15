package domain

import (
	"errors"
	"math"
	"math/bits"
	"strconv"
)

// Errors reported when an amount or a rate cannot be represented.
var (
	ErrInvalidMoney = errors.New("invalid amount")
	ErrInvalidRate  = errors.New("invalid rate")
	ErrOutOfRange   = errors.New("value out of range")
)

// Money is an amount in centavos.
//
// No floating point is involved anywhere: an amount arrives as a decimal
// string, is held as an integer, is stored as bigint and leaves as a decimal
// string again. A float would turn R$ 0,10 + R$ 0,20 into something that is
// not R$ 0,30, and a lease runs for years of such sums.
type Money int64

// MaxMoney is the largest amount accepted, R$ 999.999.999.999,99. It exists so
// that a sum of a few thousand amounts can never approach the int64 limit.
const MaxMoney Money = 99_999_999_999_999

// ParseMoney reads an amount written as digits, a dot and exactly two decimal
// places, such as "1500.00". Anything else is rejected rather than guessed at:
// "1.500,00", "1500" and "1500.5" all fail, so the value a client meant is
// never reinterpreted.
func ParseMoney(s string) (Money, error) {
	n := len(s)
	if n < 4 || s[n-3] != '.' {
		return 0, ErrInvalidMoney
	}
	whole, cents := s[:n-3], s[n-2:]
	if !allDigits(whole) || !allDigits(cents) || (len(whole) > 1 && whole[0] == '0') {
		return 0, ErrInvalidMoney
	}
	if len(whole) > 13 {
		return 0, ErrOutOfRange
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, ErrInvalidMoney
	}
	c, err := strconv.ParseInt(cents, 10, 64)
	if err != nil {
		return 0, ErrInvalidMoney
	}
	m := Money(w*100 + c)
	if m > MaxMoney {
		return 0, ErrOutOfRange
	}
	return m, nil
}

// String writes the amount in the form ParseMoney reads.
func (m Money) String() string {
	sign := ""
	v := int64(m)
	if v < 0 {
		sign = "-"
		v = -v
	}
	cents := v % 100
	s := sign + strconv.FormatInt(v/100, 10) + "."
	if cents < 10 {
		s += "0"
	}
	return s + strconv.FormatInt(cents, 10)
}

// MarshalText makes an amount a JSON string.
func (m Money) MarshalText() ([]byte, error) { return []byte(m.String()), nil }

// UnmarshalText reads a JSON string with ParseMoney.
func (m *Money) UnmarshalText(b []byte) error {
	v, err := ParseMoney(string(b))
	if err != nil {
		return err
	}
	*m = v
	return nil
}

// Valid reports whether the amount is within the accepted range.
func (m Money) Valid() bool { return m >= 0 && m <= MaxMoney }

// Add sums two amounts, refusing a result beyond MaxMoney.
func (m Money) Add(other Money) (Money, error) {
	sum := m + other
	if !m.Valid() || !other.Valid() || !sum.Valid() {
		return 0, ErrOutOfRange
	}
	return sum, nil
}

// Portion is the share a rate takes of the amount: an administration fee, a
// late penalty. Rounded half away from zero to the centavo.
func (m Money) Portion(r Rate) (Money, error) {
	v, ok := mulDivRound(int64(m), int64(r), RateScale)
	if !ok || !Money(v).Valid() {
		return 0, ErrOutOfRange
	}
	return Money(v), nil
}

// Adjust applies a rate to the amount, as a rent adjustment does:
// m × (1 + r). Rounded half away from zero to the centavo.
func (m Money) Adjust(r Rate) (Money, error) {
	v, ok := mulDivRound(int64(m), RateScale+int64(r), RateScale)
	if !ok || !Money(v).Valid() {
		return 0, ErrOutOfRange
	}
	return Money(v), nil
}

// mulDivRound computes a × b ÷ d, rounded half away from zero, using the full
// 128-bit product so that no intermediate step can overflow. It reports false
// when the result does not fit an int64. d must be positive.
func mulDivRound(a, b, d int64) (int64, bool) {
	negative := (a < 0) != (b < 0)
	hi, lo := bits.Mul64(absU(a), absU(b))
	ud := uint64(d)
	if hi >= ud {
		return 0, false
	}
	q, r := bits.Div64(hi, lo, ud)
	// r ≥ d − r is 2r ≥ d written without the chance of overflowing.
	if r >= ud-r {
		q++
	}
	if q > math.MaxInt64 {
		return 0, false
	}
	if negative {
		return -int64(q), true
	}
	return int64(q), true
}

func absU(v int64) uint64 {
	if v < 0 {
		return uint64(-v)
	}
	return uint64(v)
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
