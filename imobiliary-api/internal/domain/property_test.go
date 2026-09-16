package domain

import (
	"slices"
	"testing"
	"uuid"
)

func validProperty() *Property {
	return &Property{
		ID: uuid.NewV7(),
		Address: Address{
			Street: " Rua  das Flores ", Number: "120", District: "Centro",
			City: "Bebedouro", State: "sp", ZipCode: "14700-000",
			// A person's address fields mean nothing on a property.
			Kind: AddressResidential, IsPrimary: true,
		},
		Registry:              " 12.345 ",
		RegistryOffice:        "1º Cartório de Registro de Imóveis de Bebedouro",
		MunicipalRegistration: "01.02.003.0045",
		Owners: []PropertyOwner{
			{PersonID: uuid.NewV7(), Share: 500000},
			{PersonID: uuid.NewV7(), Share: 500000},
		},
	}
}

func TestValidPropertyIsNormalised(t *testing.T) {
	p := validProperty()
	NormalizeProperty(p)
	if err := ValidateProperty(p); err != nil {
		t.Fatalf("a valid property was refused: %v", err)
	}
	if p.Address.Street != "Rua das Flores" || p.Address.State != "SP" || p.Address.ZipCode != "14700000" {
		t.Errorf("address %+v", p.Address)
	}
	if p.Address.Kind != "" || p.Address.IsPrimary || p.Registry != "12.345" {
		t.Errorf("kind %q, primary %v, registry %q", p.Address.Kind, p.Address.IsPrimary, p.Registry)
	}
}

func TestValidatePropertyRefuses(t *testing.T) {
	third := Rate(333333)
	cases := []struct {
		name   string
		change func(*Property)
		field  string
	}{
		{"no street", func(p *Property) { p.Address.Street = "" }, "address.street"},
		{"bad state", func(p *Property) { p.Address.State = "ZZ" }, "address.state"},
		{"no owners", func(p *Property) { p.Owners = nil }, "owners"},
		{"shares short of 100", func(p *Property) { p.Owners[1].Share = 400000 }, "owners"},
		{"thirds that do not add up", func(p *Property) {
			p.Owners = []PropertyOwner{
				{PersonID: uuid.NewV7(), Share: third},
				{PersonID: uuid.NewV7(), Share: third},
				{PersonID: uuid.NewV7(), Share: third},
			}
		}, "owners"},
		{"a zero share", func(p *Property) {
			p.Owners[0].Share = 0
			p.Owners[1].Share = FullShare
		}, "owners[0].share"},
		{"the same owner twice", func(p *Property) { p.Owners[1].PersonID = p.Owners[0].PersonID }, "owners[1].person_id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := validProperty()
			c.change(p)
			NormalizeProperty(p)
			if fields := fieldsOf(t, ValidateProperty(p)); !slices.Contains(fields, c.field) {
				t.Errorf("fields %v do not include %s", fields, c.field)
			}
		})
	}

	// A third split exactly is accepted: the last owner takes the remainder.
	p := validProperty()
	p.Owners = []PropertyOwner{
		{PersonID: uuid.NewV7(), Share: third},
		{PersonID: uuid.NewV7(), Share: third},
		{PersonID: uuid.NewV7(), Share: third + 1},
	}
	NormalizeProperty(p)
	if err := ValidateProperty(p); err != nil {
		t.Errorf("33.3333 + 33.3333 + 33.3334 was refused: %v", err)
	}
}
