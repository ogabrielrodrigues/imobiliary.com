package domain

import "strings"

// One party, field by field, so a template can write its own sentence instead
// of accepting the qualification paragraph whole. The office asked for this on
// 2026-09-17: a ready-made paragraph fits one model and no other.
//
// Every value is text, already formatted the way a document says it: a CPF with
// its dots, a date as 00/00/0000, a marital status agreeing with the person's
// registered gender. What the register does not hold comes back empty rather
// than invented.

// PersonFieldSuffixes is every per-party field, in the order they are listed.
// The names are part of the API's contract, and `docs/campos.md` documents them.
var PersonFieldSuffixes = []string{
	"nome",
	"qualificacao",
	"tipo",
	"cpf",
	"cin",
	"rg",
	"cnpj",
	"nacionalidade",
	"estado_civil",
	"regime_bens",
	"profissao",
	"nascimento",
	"email",
	"telefone",
	"nome_fantasia",
	"representante_nome",
	"representante_cpf",
	"representante_qualificacao",
	"conjuge_nome",
	"conjuge_cpf",
	"endereco",
	"endereco_logradouro",
	"endereco_numero",
	"endereco_complemento",
	"endereco_bairro",
	"endereco_cidade",
	"endereco_uf",
	"endereco_cep",
}

// PersonFields computes one party's fields, keyed by the suffixes above.
//
// `people` holds everyone that may be referred to by id: a company's
// representatives and an individual's spouse. Anyone missing from it is left
// out rather than guessed at.
func PersonFields(p *Person, people map[string]*Person) map[string]string {
	values := map[string]string{
		"nome":         p.Name,
		"qualificacao": Qualify(p, people),
		"tipo":         "Pessoa física",
		"email":        p.Email,
		"telefone":     p.Phone,
	}
	if p.Kind == PersonCompany {
		values["tipo"] = "Pessoa jurídica"
	}

	a := AgreementOf(p)

	if p.CPF != "" {
		cpf := FormatCPF(p.CPF)
		values["cpf"] = cpf
		// The CIN carries the CPF's number, decided with the user on
		// 2026-09-17, and a model still written for the old document reads the
		// same number under "RG".
		values["cin"] = cpf
		values["rg"] = cpf
	}
	if p.CNPJ != "" {
		values["cnpj"] = FormatCNPJ(p.CNPJ)
	}
	values["nacionalidade"] = p.Nationality
	if words, ok := maritalWords[p.MaritalStatus]; ok {
		status := inflect(a, words[0], words[1])
		if p.MaritalStatus == MaritalStableUnion {
			status = words[0]
		}
		values["estado_civil"] = status
	}
	if regime, ok := regimeWords[p.PropertyRegime]; ok {
		values["regime_bens"] = regime
	}
	values["profissao"] = p.Occupation
	if !p.BirthDate.IsZero() {
		values["nascimento"] = DateText(p.BirthDate)
	}
	values["nome_fantasia"] = p.TradeName

	if len(p.RepresentativeIDs) > 0 {
		var names, cpfs, quals []string
		for _, id := range p.RepresentativeIDs {
			rep, ok := people[id.String()]
			if !ok {
				continue
			}
			names = append(names, rep.Name)
			if rep.CPF != "" {
				cpfs = append(cpfs, FormatCPF(rep.CPF))
			}
			quals = append(quals, Qualify(rep, people))
		}
		values["representante_nome"] = JoinNames(names)
		values["representante_cpf"] = strings.Join(cpfs, ", ")
		values["representante_qualificacao"] = JoinParts(quals)
	}

	if p.SpouseID != nil {
		if spouse, ok := people[p.SpouseID.String()]; ok {
			values["conjuge_nome"] = spouse.Name
			if spouse.CPF != "" {
				values["conjuge_cpf"] = FormatCPF(spouse.CPF)
			}
		}
	}

	if address, ok := mainAddress(p); ok {
		values["endereco"] = AddressText(address)
		values["endereco_logradouro"] = address.Street
		values["endereco_numero"] = address.Number
		values["endereco_complemento"] = address.Complement
		values["endereco_bairro"] = address.District
		values["endereco_cidade"] = address.City
		values["endereco_uf"] = address.State
		if len(address.ZipCode) == 8 {
			values["endereco_cep"] = address.ZipCode[:5] + "-" + address.ZipCode[5:]
		}
	}
	return values
}
