package domain

import (
	"errors"
	"testing"
)

func TestParseRate(t *testing.T) {
	valid := []struct {
		in   string
		want Rate
		out  string
	}{
		{"10", 100_000, "10.00"},
		{"10.5", 105_000, "10.50"},
		{"0", 0, "0.00"},
		{"3.1812", 31_812, "3.1812"},
		{"-3.1812", -31_812, "-3.1812"},
		{"0.0001", 1, "0.0001"},
		{"-0.5", -5_000, "-0.50"},
		{"100", RateScale, "100.00"},
		{"1000", MaxRate, "1000.00"},
		{"-1000", -MaxRate, "-1000.00"},
	}
	for _, c := range valid {
		got, err := ParseRate(c.in)
		if err != nil || got != c.want {
			t.Errorf("ParseRate(%q) = %d, %v; want %d", c.in, got, err, c.want)
			continue
		}
		if got.String() != c.out {
			t.Errorf("Rate(%d).String() = %q, want %q", got, got.String(), c.out)
		}
	}

	for _, in := range []string{"", "-", ".5", "10.", "10,5", "+10", "10%", " 10", "01", "1.00001", "1e2", "--1"} {
		if _, err := ParseRate(in); err == nil {
			t.Errorf("ParseRate(%q) accepted a malformed rate", in)
		}
	}
	for _, in := range []string{"1000.0001", "-1000.0001", "10000"} {
		if _, err := ParseRate(in); !errors.Is(err, ErrOutOfRange) {
			t.Errorf("ParseRate(%q) error = %v, want ErrOutOfRange", in, err)
		}
	}
}

func FuzzParseRate(f *testing.F) {
	for _, seed := range []string{"10", "-3.1812", "0.0001", "1000", "1.00001"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		r, err := ParseRate(s)
		if err != nil {
			return
		}
		if r > MaxRate || r < -MaxRate {
			t.Fatalf("ParseRate(%q) = %d, outside the valid range", s, r)
		}
		// The canonical text form must read back as the same rate.
		again, err := ParseRate(r.String())
		if err != nil || again != r {
			t.Fatalf("ParseRate(%q) = %d, but its text %q reads as %d, %v", s, r, r.String(), again, err)
		}
	})
}
