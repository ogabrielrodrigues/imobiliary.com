package domain

import "testing"

func TestRetentionEnds(t *testing.T) {
	for _, c := range []struct{ last, ends string }{
		{"2020-03-15", "2026-01-01"},
		{"2020-12-31", "2026-01-01"},
		{"2021-01-01", "2027-01-01"},
	} {
		if got := RetentionEnds(date(t, c.last)).String(); got != c.ends {
			t.Errorf("last event %s: ends %s, want %s", c.last, got, c.ends)
		}
	}
	if PastRetention(date(t, "2020-06-01"), date(t, "2025-12-31")) {
		t.Error("a 2020 record was released on the last day of 2025")
	}
	if !PastRetention(date(t, "2020-06-01"), date(t, "2026-01-01")) {
		t.Error("a 2020 record was kept on the first day of 2026")
	}
}
