package domain

import "testing"

// Each person agrees on their own, so two people in one role can be written
// "inscrito" and "inscrita" in the same document.
func TestPersonFieldEndings(t *testing.T) {
	cases := []struct {
		name   string
		person *Person
		o, a   string
	}{
		{"man", individualFor("CAIO", GenderMale), "o", ""},
		{"woman", individualFor("ANA", GenderFemale), "a", "a"},
		{"no gender", individualFor("ALEX", ""), "o(a)", "(a)"},
		{"company", &Person{Kind: PersonCompany, Name: "ACME LTDA"}, "a", "a"},
	}
	for _, c := range cases {
		fields := PersonFields(c.person, nil)
		if fields["o"] != c.o || fields["a"] != c.a {
			t.Errorf("%s: o=%q a=%q, want o=%q a=%q", c.name, fields["o"], fields["a"], c.o, c.a)
		}
	}
}
