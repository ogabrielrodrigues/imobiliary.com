package domain

import (
	json "encoding/json/v2"
	"testing"
	"time"
	// Windows has no zone database; the service embeds one the same way.
	_ "time/tzdata"
)

func mustDate(t *testing.T, s string) Date {
	t.Helper()
	d, err := ParseDate(s)
	if err != nil {
		t.Fatalf("ParseDate(%q): %v", s, err)
	}
	return d
}

func TestParseDate(t *testing.T) {
	for _, in := range []string{"2026-01-10", "2024-02-29", "0001-01-01", "9999-12-31"} {
		if d := mustDate(t, in); d.String() != in {
			t.Errorf("ParseDate(%q).String() = %q", in, d.String())
		}
	}
	for _, in := range []string{"", "2026-02-30", "2025-02-29", "2026-13-01", "2026-1-10", "10/01/2026", "2026-01-10T00:00:00Z", "0000-01-01"} {
		if _, err := ParseDate(in); err == nil {
			t.Errorf("ParseDate(%q) accepted an invalid date", in)
		}
	}
}

func TestDateAddMonthsClampsToTheLastDay(t *testing.T) {
	cases := []struct {
		from, want string
		months     int
	}{
		{"2026-01-31", "2026-02-28", 1},
		{"2028-01-31", "2028-02-29", 1},
		{"2026-01-31", "2026-04-30", 3},
		{"2026-03-31", "2026-02-28", -1},
		{"2026-11-10", "2027-01-10", 2},
		{"2026-01-10", "2028-07-10", 30},
		{"2026-05-15", "2025-05-15", -12},
	}
	for _, c := range cases {
		if got := mustDate(t, c.from).AddMonths(c.months); got.String() != c.want {
			t.Errorf("%s + %d months = %s, want %s", c.from, c.months, got, c.want)
		}
	}
}

func TestDateInMonth(t *testing.T) {
	if got := DateInMonth(2026, time.February, 31); got.String() != "2026-02-28" {
		t.Errorf("due day 31 in February 2026 = %s", got)
	}
	if got := DateInMonth(2026, time.April, 31); got.String() != "2026-04-30" {
		t.Errorf("due day 31 in April = %s", got)
	}
	if got := DateInMonth(2026, time.March, 10); got.String() != "2026-03-10" {
		t.Errorf("due day 10 in March = %s", got)
	}
}

func TestDateOfUsesTheLocationsCalendar(t *testing.T) {
	saoPaulo, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	// 01:30 UTC on the 11th is still 22:30 on the 10th in São Paulo.
	instant := time.Date(2026, time.January, 11, 1, 30, 0, 0, time.UTC)
	if got := DateOf(instant, saoPaulo); got.String() != "2026-01-10" {
		t.Errorf("DateOf in São Paulo = %s, want 2026-01-10", got)
	}
	if got := DateOf(instant, time.UTC); got.String() != "2026-01-11" {
		t.Errorf("DateOf in UTC = %s, want 2026-01-11", got)
	}
}

func TestDateCompareAndDays(t *testing.T) {
	a, b := mustDate(t, "2026-02-28"), mustDate(t, "2026-03-01")
	if !a.Before(b) || !b.After(a) || a.Compare(a) != 0 {
		t.Error("comparison is wrong")
	}
	if n := a.DaysUntil(b); n != 1 {
		t.Errorf("DaysUntil = %d, want 1", n)
	}
	if got := a.AddDays(1); got != b {
		t.Errorf("AddDays(1) = %s, want %s", got, b)
	}
}

func TestDateJSON(t *testing.T) {
	type payload struct {
		SignedOn Date  `json:"signed_on"`
		EndedOn  *Date `json:"ended_on,omitzero"`
	}
	var p payload
	if err := json.Unmarshal([]byte(`{"signed_on":"2026-01-10"}`), &p); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"signed_on":"2026-01-10"}` {
		t.Errorf("round trip = %s", out)
	}
	if err := json.Unmarshal([]byte(`{"signed_on":"2026-02-30"}`), &p); err == nil {
		t.Error("an impossible date was accepted from JSON")
	}
}
