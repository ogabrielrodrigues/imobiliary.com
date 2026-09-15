package domain

import (
	"errors"
	"testing"
)

func TestParseMoney(t *testing.T) {
	valid := map[string]Money{
		"0.00":             0,
		"0.01":             1,
		"0.10":             10,
		"7.05":             705,
		"1500.00":          150_000,
		"1234.56":          123_456,
		"123456789012.34":  12_345_678_901_234,
		"999999999999.99":  MaxMoney,
		"1000000000000.00": -1, // one centavo past MaxMoney, rejected below
		"9999999999999.99": -1,
	}
	for in, want := range valid {
		got, err := ParseMoney(in)
		if want < 0 {
			if !errors.Is(err, ErrOutOfRange) {
				t.Errorf("ParseMoney(%q) error = %v, want ErrOutOfRange", in, err)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("ParseMoney(%q) = %d, %v; want %d", in, got, err, want)
			continue
		}
		if got.String() != in {
			t.Errorf("Money(%d).String() = %q, want %q", got, got.String(), in)
		}
	}

	for _, in := range []string{
		"", "0", "1500", "1500.0", "1500.000", "1.500,00", "1500,00", "-1.00",
		"+1.00", " 1.00", "1.00 ", "01.00", "00.00", ".50", "1.", "1..00",
		"1e3.00", "１.00", "R$ 1.00", "1_000.00",
	} {
		if _, err := ParseMoney(in); err == nil {
			t.Errorf("ParseMoney(%q) accepted a malformed amount", in)
		}
	}
}

func TestMoneyAdjustAndPortion(t *testing.T) {
	cases := []struct {
		name     string
		amount   string
		rate     string
		adjusted string
		portion  string
	}{
		{"ten percent fee", "1500.00", "10", "1650.00", "150.00"},
		{"index with four decimals", "2000.00", "3.1812", "2063.62", "63.62"},
		{"negative index", "2000.00", "-3.1812", "1936.38", "-63.62"},
		{"half a centavo rounds up", "0.05", "10", "0.06", "0.01"},
		{"just under half rounds down", "0.04", "10", "0.04", "0.00"},
		{"zero rate", "1234.56", "0", "1234.56", "0.00"},
		{"full loss", "1234.56", "-100", "0.00", "-1234.56"},
		{"largest amount, largest rate", "999999999.99", "1000", "10999999999.89", "9999999999.90"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := ParseMoney(c.amount)
			if err != nil {
				t.Fatal(err)
			}
			r, err := ParseRate(c.rate)
			if err != nil {
				t.Fatal(err)
			}
			adjusted, err := m.Adjust(r)
			if err != nil || adjusted.String() != c.adjusted {
				t.Errorf("Adjust = %s, %v; want %s", adjusted, err, c.adjusted)
			}

			// A negative portion is a valid calculation but not a valid amount,
			// so it is reported through the raw computation instead.
			v, ok := mulDivRound(int64(m), int64(r), RateScale)
			if !ok || Money(v).String() != c.portion {
				t.Errorf("portion = %s, %v; want %s", Money(v), ok, c.portion)
			}
			if p, err := m.Portion(r); v >= 0 && (err != nil || p != Money(v)) {
				t.Errorf("Portion = %s, %v; want %s", p, err, Money(v))
			}
		})
	}
}

func TestMoneyAdjustRejectsOverflow(t *testing.T) {
	if _, err := MaxMoney.Adjust(MaxRate); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Adjust beyond MaxMoney: error = %v, want ErrOutOfRange", err)
	}
	if _, err := MaxMoney.Add(1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Add beyond MaxMoney: error = %v, want ErrOutOfRange", err)
	}
}

func TestMulDivRoundMatchesWideArithmetic(t *testing.T) {
	// mulDivRound must not overflow where a plain int64 product would.
	got, ok := mulDivRound(int64(MaxMoney), int64(MaxRate), RateScale)
	if !ok || got != int64(MaxMoney)*10 {
		t.Fatalf("mulDivRound(MaxMoney, MaxRate) = %d, %v", got, ok)
	}
}

func FuzzParseMoney(f *testing.F) {
	for _, seed := range []string{"0.00", "1500.00", "999999999999.99", "1.5", "-1.00", "01.00"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		m, err := ParseMoney(s)
		if err != nil {
			return
		}
		if !m.Valid() {
			t.Fatalf("ParseMoney(%q) = %d, outside the valid range", s, m)
		}
		// Whatever is accepted is written back exactly as it was read.
		if m.String() != s {
			t.Fatalf("ParseMoney(%q).String() = %q", s, m.String())
		}
	})
}

func FuzzMoneyAdjust(f *testing.F) {
	f.Add(int64(150_000), int32(100_000))
	f.Add(int64(MaxMoney), int32(MaxRate))
	f.Add(int64(1), int32(-1_000_000))
	f.Fuzz(func(t *testing.T, amount int64, rate int32) {
		m, r := Money(amount), Rate(rate)
		if !m.Valid() || r > MaxRate || r < -MaxRate {
			return
		}
		adjusted, err := m.Adjust(r)
		if err != nil {
			return
		}
		// Adjusting and taking the portion must agree to within one centavo of
		// rounding: m × (1 + r) = m + m × r.
		v, ok := mulDivRound(int64(m), int64(r), RateScale)
		if !ok {
			t.Fatalf("portion overflowed where the adjustment did not")
		}
		if diff := int64(adjusted) - (int64(m) + v); diff < -1 || diff > 1 {
			t.Fatalf("Adjust(%d, %d) = %d, but m + portion = %d", m, r, adjusted, int64(m)+v)
		}
	})
}
