package http

import "testing"

// TestRateKeyGroupsAnIPv6NetworkUnderOneKey covers the bypass the grouping
// closes: rotating through a /64 must not buy a fresh allowance per address.
func TestRateKeyGroupsAnIPv6NetworkUnderOneKey(t *testing.T) {
	a := rateKey("2001:db8:1:2:aaaa::1")
	b := rateKey("2001:db8:1:2:bbbb:cccc:dddd:9")
	if a != b {
		t.Errorf("two addresses in one /64 got keys %q and %q", a, b)
	}
	if other := rateKey("2001:db8:1:3::1"); other == a {
		t.Error("two different /64 networks share a key")
	}

	if got := rateKey("203.0.113.7"); got != "203.0.113.7" {
		t.Errorf("an IPv4 address was rewritten to %q", got)
	}
	if got := rateKey("::ffff:203.0.113.7"); got != "203.0.113.7" {
		t.Errorf("an IPv4-mapped address was keyed as %q, not as its IPv4 form", got)
	}
	if got := rateKey("not-an-address"); got != "not-an-address" {
		t.Errorf("an unparseable value was rewritten to %q", got)
	}
}
