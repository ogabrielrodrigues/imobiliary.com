package domain

import (
	"strings"
)

// The text a lease document says about its parties, built from the register
// so the office never types it (PLANO-FASE-7.md §3). The rules for gender and
// number were decided with the user on 2026-09-17: agreement follows each
// person's registered gender, and a role with an individual whose gender is
// not registered reads neutral ("locatário(a)").

// Agreement is how a word agrees with the people it refers to.
type Agreement int

const (
	// AgreeNeutral writes both forms: "locatário(a)".
	AgreeNeutral Agreement = iota
	AgreeMasculine
	AgreeFeminine
)

// AgreementOf is the agreement for one person. A company is feminine, as it
// stands for "a sociedade", "a pessoa jurídica".
func AgreementOf(p *Person) Agreement {
	switch {
	case p.Kind == PersonCompany:
		return AgreeFeminine
	case p.Gender == GenderFemale:
		return AgreeFeminine
	case p.Gender == GenderMale:
		return AgreeMasculine
	}
	return AgreeNeutral
}

// GroupAgreement is the agreement for several people in one role: all
// feminine is feminine, any masculine is masculine, and any unknown gender
// makes the whole role neutral.
func GroupAgreement(people []*Person) Agreement {
	result := AgreeFeminine
	for _, p := range people {
		switch AgreementOf(p) {
		case AgreeNeutral:
			return AgreeNeutral
		case AgreeMasculine:
			result = AgreeMasculine
		}
	}
	return result
}

// inflect picks the form of a word: masculine and feminine singular, and the
// neutral form is built from them ("portador" and "portadora" give
// "portador(a)").
func inflect(a Agreement, masculine, feminine string) string {
	switch a {
	case AgreeMasculine:
		return masculine
	case AgreeFeminine:
		return feminine
	}
	return neutralForm(masculine, feminine)
}

// neutralForm writes both genders in one word: "locador(a)", "locatário(a)",
// "domiciliado(a)", "os(as)".
func neutralForm(masculine, feminine string) string {
	switch {
	case strings.HasSuffix(masculine, "o") && strings.HasSuffix(feminine, "a"):
		return masculine + "(a)"
	case strings.HasSuffix(masculine, "os") && strings.HasSuffix(feminine, "as"):
		return masculine + "(as)"
	case feminine == masculine+"a":
		return masculine + "(a)"
	case feminine == strings.TrimSuffix(masculine, "es")+"as":
		return masculine + "(as)"
	}
	return masculine + "/" + feminine
}

// RoleNoun is a party's role as the document names it.
type RoleNoun struct{ Singular, Feminine, Plural, FemininePlural string }

var (
	NounLandlord  = RoleNoun{"locador", "locadora", "locadores", "locadoras"}
	NounTenant    = RoleNoun{"locatário", "locatária", "locatários", "locatárias"}
	NounGuarantor = RoleNoun{"fiador", "fiadora", "fiadores", "fiadoras"}
)

// Term is the role with its article, agreeing with the people in it: "o
// locatário", "a locatária", "os locatários", "o(a) locatário(a)".
func (n RoleNoun) Term(people []*Person) string {
	a := GroupAgreement(people)
	if len(people) > 1 {
		return inflect(a, "os", "as") + " " + inflect(a, n.Plural, n.FemininePlural)
	}
	return inflect(a, "o", "a") + " " + inflect(a, n.Singular, n.Feminine)
}

// Contraction is the role after a preposition that fuses with the article:
// "de" gives "do locador", "da locadora", "dos(as) locadores(as)"; "a" gives
// "ao locador", "à locadora"; "em" gives "no"; "por" gives "pelo".
func (n RoleNoun) Contraction(preposition string, people []*Person) string {
	forms := map[string][4]string{
		"de":  {"do", "da", "dos", "das"},
		"a":   {"ao", "à", "aos", "às"},
		"em":  {"no", "na", "nos", "nas"},
		"por": {"pelo", "pela", "pelos", "pelas"},
	}[preposition]
	a := GroupAgreement(people)
	if len(people) > 1 {
		return articleForm(a, forms[2], forms[3]) + " " + inflect(a, n.Plural, n.FemininePlural)
	}
	return articleForm(a, forms[0], forms[1]) + " " + inflect(a, n.Singular, n.Feminine)
}

// articleForm writes an article or a contraction in the agreement, with a
// neutral form that keeps both: "o(a)", "do(a)", "ao(à)", "pelos(as)".
func articleForm(a Agreement, masculine, feminine string) string {
	switch a {
	case AgreeMasculine:
		return masculine
	case AgreeFeminine:
		return feminine
	}
	if masculine == "ao" || masculine == "aos" {
		return masculine + "(" + feminine + ")"
	}
	return neutralForm(masculine, feminine)
}

// TermStart is Term for the start of a sentence: "A locatária", "O(a) locatário(a)".
func (n RoleNoun) TermStart(people []*Person) string {
	term := n.Term(people)
	if term == "" {
		return ""
	}
	return strings.ToUpper(term[:1]) + term[1:]
}

// Ending is the ending a word agreeing with the role takes, so a template can
// write "obrigad{{.locatario_o}}": "o", "a", "os", "as", "o(a)", "os(as)".
func (n RoleNoun) Ending(people []*Person) string {
	a := GroupAgreement(people)
	if len(people) > 1 {
		return inflect(a, "os", "as")
	}
	return inflect(a, "o", "a")
}

// Title is the role as a heading: "LOCATÁRIO", "LOCATÁRIAS", "LOCATÁRIO(A)".
func (n RoleNoun) Title(people []*Person) string {
	a := GroupAgreement(people)
	if len(people) > 1 {
		return strings.ToUpper(inflect(a, n.Plural, n.FemininePlural))
	}
	return strings.ToUpper(inflect(a, n.Singular, n.Feminine))
}

var maritalWords = map[MaritalStatus][2]string{
	MaritalSingle:      {"solteiro", "solteira"},
	MaritalMarried:     {"casado", "casada"},
	MaritalDivorced:    {"divorciado", "divorciada"},
	MaritalSeparated:   {"separado", "separada"},
	MaritalWidowed:     {"viúvo", "viúva"},
	MaritalStableUnion: {"convivente em união estável", "convivente em união estável"},
}

var regimeWords = map[PropertyRegime]string{
	RegimePartialCommunity:    "comunhão parcial de bens",
	RegimeUniversalCommunity:  "comunhão universal de bens",
	RegimeTotalSeparation:     "separação total de bens",
	RegimeMandatorySeparation: "separação obrigatória de bens",
	RegimeFinalParticipation:  "participação final nos aquestos",
}

// AddressText writes an address in one line: "Rua das Flores, 120, apto 12,
// Centro, Colina/SP, CEP 14770-000".
func AddressText(a Address) string {
	var parts []string
	for _, p := range []string{a.Street, a.Number, a.Complement, a.District} {
		if strings.TrimSpace(p) != "" {
			parts = append(parts, p)
		}
	}
	switch {
	case a.City != "" && a.State != "":
		parts = append(parts, a.City+"/"+a.State)
	case a.City != "":
		parts = append(parts, a.City)
	}
	if len(a.ZipCode) == 8 {
		parts = append(parts, "CEP "+a.ZipCode[:5]+"-"+a.ZipCode[5:])
	}
	return strings.Join(parts, ", ")
}

// mainAddress is the address a qualification uses: the primary one, else a
// residential or commercial one as the kind suits, else the first.
func mainAddress(p *Person) (Address, bool) {
	if len(p.Addresses) == 0 {
		return Address{}, false
	}
	for _, a := range p.Addresses {
		if a.IsPrimary {
			return a, true
		}
	}
	want := AddressResidential
	if p.Kind == PersonCompany {
		want = AddressCommercial
	}
	for _, a := range p.Addresses {
		if a.Kind == want {
			return a, true
		}
	}
	return p.Addresses[0], true
}

// Qualify writes one person's qualification. A company's representatives are
// looked up in people by id and qualified after it; one not found is left
// out. Parts the register does not hold are left out, never invented.
func Qualify(p *Person, people map[string]*Person) string {
	if p.Kind == PersonCompany {
		return qualifyCompany(p, people)
	}
	a := AgreementOf(p)
	parts := []string{p.Name}
	if p.Nationality != "" {
		parts = append(parts, p.Nationality)
	}
	if words, ok := maritalWords[p.MaritalStatus]; ok {
		status := inflect(a, words[0], words[1])
		if p.MaritalStatus == MaritalStableUnion {
			status = words[0]
		}
		if regime, ok := regimeWords[p.PropertyRegime]; ok && p.MaritalStatus.HasPartner() {
			status += " sob o regime da " + regime
		}
		parts = append(parts, status)
	}
	if p.Occupation != "" {
		parts = append(parts, p.Occupation)
	}
	if p.CPF != "" {
		cpf := FormatCPF(p.CPF)
		// The CIN carries the CPF's number (decided with the user): the same
		// number identifies the person in both documents.
		parts = append(parts,
			inflect(a, "portador", "portadora")+" da Carteira de Identidade Nacional (CIN) n.º "+cpf,
			inflect(a, "inscrito", "inscrita")+" no CPF sob o n.º "+cpf)
	}
	if address, ok := mainAddress(p); ok {
		parts = append(parts, "residente e "+inflect(a, "domiciliado", "domiciliada")+" à "+AddressText(address))
	}
	return strings.Join(parts, ", ")
}

func qualifyCompany(p *Person, people map[string]*Person) string {
	parts := []string{p.Name}
	if p.TradeName != "" {
		parts = append(parts, "nome fantasia "+p.TradeName)
	}
	parts = append(parts, "pessoa jurídica de direito privado")
	if p.CNPJ != "" {
		parts = append(parts, "inscrita no CNPJ sob o n.º "+FormatCNPJ(p.CNPJ))
	}
	if address, ok := mainAddress(p); ok {
		parts = append(parts, "com sede à "+AddressText(address))
	}
	text := strings.Join(parts, ", ")

	var reps []string
	for _, id := range p.RepresentativeIDs {
		if rep, ok := people[id.String()]; ok {
			reps = append(reps, Qualify(rep, people))
		}
	}
	if len(reps) > 0 {
		text += ", neste ato representada por " + JoinParts(reps)
	}
	return text
}

// JoinParts joins several qualifications or names: "A", "A e B", "A; B; e C".
// Qualifications hold commas, so more than two are separated by semicolons.
func JoinParts(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	case 2:
		return items[0] + "; e " + items[1]
	}
	return strings.Join(items[:len(items)-1], "; ") + "; e " + items[len(items)-1]
}

// JoinNames joins plain names: "A", "A e B", "A, B e C".
func JoinNames(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " e " + names[len(names)-1]
}
