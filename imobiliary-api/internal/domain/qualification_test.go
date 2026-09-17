package domain

import (
	"strings"
	"testing"
	"uuid"
)

func individualFor(name string, gender Gender) *Person {
	return &Person{
		ID: uuid.NewV7(), Kind: PersonIndividual, Name: name, Gender: gender,
		Nationality: "brasileira", MaritalStatus: MaritalMarried, PropertyRegime: RegimePartialCommunity,
		Occupation: "professora", CPF: "52998224725",
		Addresses: []Address{{Kind: AddressResidential, Street: "Rua das Flores", Number: "120", District: "Centro",
			City: "Colina", State: "SP", ZipCode: "14770000"}},
	}
}

func TestRoleTerms(t *testing.T) {
	ana := individualFor("Ana", GenderFemale)
	bia := individualFor("Bia", GenderFemale)
	caio := individualFor("Caio", GenderMale)
	sem := individualFor("Sem Gênero", "")
	empresa := &Person{Kind: PersonCompany, Name: "Acme Ltda"}

	for _, c := range []struct {
		noun   RoleNoun
		people []*Person
		term   string
		title  string
	}{
		{NounTenant, []*Person{ana}, "a locatária", "LOCATÁRIA"},
		{NounTenant, []*Person{caio}, "o locatário", "LOCATÁRIO"},
		{NounTenant, []*Person{sem}, "o(a) locatário(a)", "LOCATÁRIO(A)"},
		{NounTenant, []*Person{ana, bia}, "as locatárias", "LOCATÁRIAS"},
		{NounTenant, []*Person{ana, caio}, "os locatários", "LOCATÁRIOS"},
		{NounTenant, []*Person{ana, sem}, "os(as) locatários(as)", "LOCATÁRIOS(AS)"},
		{NounTenant, []*Person{empresa}, "a locatária", "LOCATÁRIA"},
		{NounLandlord, []*Person{sem}, "o(a) locador(a)", "LOCADOR(A)"},
		{NounLandlord, []*Person{caio, sem}, "os(as) locadores(as)", "LOCADORES(AS)"},
		{NounGuarantor, []*Person{ana}, "a fiadora", "FIADORA"},
	} {
		if got := c.noun.Term(c.people); got != c.term {
			t.Errorf("Term = %q, want %q", got, c.term)
		}
		if got := c.noun.Title(c.people); got != c.title {
			t.Errorf("Title = %q, want %q", got, c.title)
		}
	}
}

func TestQualify(t *testing.T) {
	ana := individualFor("ANA SOUZA", GenderFemale)
	want := "ANA SOUZA, brasileira, casada sob o regime da comunhão parcial de bens, professora, " +
		"portadora da Carteira de Identidade Nacional (CIN) n.º 529.982.247-25, inscrita no CPF sob o n.º 529.982.247-25, " +
		"residente e domiciliada à Rua das Flores, 120, Centro, Colina/SP, CEP 14770-000"
	if got := Qualify(ana, nil); got != want {
		t.Errorf("female individual:\n got %q\nwant %q", got, want)
	}

	sem := &Person{Kind: PersonIndividual, Name: "JOSÉ LIMA", MaritalStatus: MaritalSingle, CPF: "11144477735"}
	want = "JOSÉ LIMA, solteiro(a), portador(a) da Carteira de Identidade Nacional (CIN) n.º 111.444.777-35, " +
		"inscrito(a) no CPF sob o n.º 111.444.777-35"
	if got := Qualify(sem, nil); got != want {
		t.Errorf("without gender or address:\n got %q\nwant %q", got, want)
	}

	caio := individualFor("CAIO DIAS", GenderMale)
	caio.Nationality, caio.Occupation, caio.MaritalStatus = "brasileiro", "engenheiro", MaritalStableUnion
	rep := individualFor("BIA DIAS", GenderFemale)
	empresa := &Person{
		Kind: PersonCompany, Name: "ACME LTDA", TradeName: "Acme", CNPJ: "12ABC34501DE35",
		RepresentativeIDs: []uuid.UUID{caio.ID, rep.ID},
		Addresses:         []Address{{Kind: AddressCommercial, Street: "Av. Brasil", Number: "1", City: "Colina", State: "SP"}},
	}
	people := map[string]*Person{caio.ID.String(): caio, rep.ID.String(): rep}
	got := Qualify(empresa, people)
	wantPrefix := "ACME LTDA, nome fantasia Acme, pessoa jurídica de direito privado, inscrita no CNPJ sob o n.º 12.ABC.345/01DE-35, " +
		"com sede à Av. Brasil, 1, Colina/SP, neste ato representada por CAIO DIAS, brasileiro, convivente em união estável sob o regime da comunhão parcial de bens, engenheiro, portador"
	if len(got) < len(wantPrefix) || got[:len(wantPrefix)] != wantPrefix {
		t.Errorf("company:\n got %q\nwant prefix %q", got, wantPrefix)
	}
	if !strings.Contains(got, "; e BIA DIAS, brasileira") {
		t.Errorf("company representatives not joined: %q", got)
	}
}

func TestJoin(t *testing.T) {
	if got := JoinNames([]string{"A", "B", "C"}); got != "A, B e C" {
		t.Errorf("JoinNames = %q", got)
	}
	if got := JoinParts([]string{"A, x", "B, y", "C, z"}); got != "A, x; B, y; e C, z" {
		t.Errorf("JoinParts = %q", got)
	}
}
