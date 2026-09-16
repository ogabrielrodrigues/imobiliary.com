package domain

import (
	"slices"
	"testing"
	"uuid"
)

func validIndividual() *Person {
	return &Person{
		ID:            uuid.NewV7(),
		Kind:          PersonIndividual,
		Name:          "  Maria   da Conceição ",
		Email:         " Maria@Example.com ",
		Phone:         "(16) 99123-4567",
		CPF:           "529.982.247-25",
		Nationality:   "brasileira",
		MaritalStatus: MaritalSingle,
		Gender:        GenderFemale,
		Addresses: []Address{{
			Kind: AddressResidential, IsPrimary: true, Street: "Rua das Flores", Number: "120",
			District: "Centro", City: "Bebedouro", State: "sp", ZipCode: "14700-000",
		}},
	}
}

func TestNormalizePersonCanonicalises(t *testing.T) {
	p := validIndividual()
	NormalizePerson(p)

	if p.Name != "Maria da Conceição" || p.Email != "maria@example.com" || p.Phone != "16991234567" {
		t.Errorf("name %q, email %q, phone %q", p.Name, p.Email, p.Phone)
	}
	if p.CPF != "52998224725" {
		t.Errorf("cpf = %q", p.CPF)
	}
	if a := p.Addresses[0]; a.State != "SP" || a.ZipCode != "14700000" {
		t.Errorf("state %q, zip %q", a.State, a.ZipCode)
	}
	if err := ValidatePerson(p); err != nil {
		t.Fatalf("a valid individual was refused: %v", err)
	}
}

func TestValidatePersonRefuses(t *testing.T) {
	spouse := uuid.NewV7()
	cases := []struct {
		name   string
		change func(*Person)
		field  string
	}{
		{"no name", func(p *Person) { p.Name = "" }, "name"},
		{"bad kind", func(p *Person) { p.Kind = "robot" }, "kind"},
		{"bad CPF", func(p *Person) { p.CPF = "111.111.111-11" }, "cpf"},
		{"bad email", func(p *Person) { p.Email = "not-an-address" }, "email"},
		{"short phone", func(p *Person) { p.Phone = "9912-3456" }, "phone"},
		{"regime without partner", func(p *Person) { p.PropertyRegime = RegimePartialCommunity }, "property_regime"},
		{"spouse while single", func(p *Person) { p.SpouseID = &spouse }, "spouse_id"},
		{"self as spouse", func(p *Person) { p.MaritalStatus = MaritalMarried; p.SpouseID = &p.ID }, "spouse_id"},
		{"unknown status", func(p *Person) { p.MaritalStatus = "complicated" }, "marital_status"},
		{"CNPJ on an individual", func(p *Person) { p.CNPJ = "12.ABC.345/01DE-35" }, "cnpj"},
		{"unknown state", func(p *Person) { p.Addresses[0].State = "XX" }, "addresses[0].state"},
		{"short CEP", func(p *Person) { p.Addresses[0].ZipCode = "1470" }, "addresses[0].zip_code"},
		{"two primaries", func(p *Person) {
			second := p.Addresses[0]
			p.Addresses = append(p.Addresses, second)
		}, "addresses"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := validIndividual()
			c.change(p)
			NormalizePerson(p)
			if fields := fieldsOf(t, ValidatePerson(p)); !slices.Contains(fields, c.field) {
				t.Errorf("fields %v do not include %s", fields, c.field)
			}
		})
	}
}

func TestValidateCompany(t *testing.T) {
	representative := uuid.NewV7()
	company := &Person{
		ID: uuid.NewV7(), Kind: PersonCompany, Name: "Prado Imóveis Ltda",
		TradeName: "Prado", CNPJ: "12.abc.345/01de-35", RepresentativeIDs: []uuid.UUID{representative},
	}
	NormalizePerson(company)
	if company.CNPJ != "12ABC34501DE35" {
		t.Errorf("cnpj = %q", company.CNPJ)
	}
	if err := ValidatePerson(company); err != nil {
		t.Fatalf("a valid company was refused: %v", err)
	}

	company.CPF = "52998224725"
	company.MaritalStatus = MaritalMarried
	company.RepresentativeIDs = append(company.RepresentativeIDs, representative, company.ID)
	fields := fieldsOf(t, ValidatePerson(company))
	for _, want := range []string{"cpf", "marital_status", "representative_ids"} {
		if !slices.Contains(fields, want) {
			t.Errorf("fields %v do not include %s", fields, want)
		}
	}
}

func TestNormalizePhone(t *testing.T) {
	for input, want := range map[string]string{
		"(16) 3342-1000":    "1633421000",
		"+55 16 99123-4567": "5516991234567",
	} {
		if got, ok := NormalizePhone(input); !ok || got != want {
			t.Errorf("NormalizePhone(%q) = %q, %v", input, got, ok)
		}
	}
	for _, input := range []string{"123", "16 9912a-4567", "+55 (16) 99123-4567 99"} {
		if _, ok := NormalizePhone(input); ok {
			t.Errorf("NormalizePhone(%q) accepted", input)
		}
	}
}
