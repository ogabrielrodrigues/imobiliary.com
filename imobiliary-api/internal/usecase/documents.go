package usecase

import (
	"context"
	"fmt"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Documents computes what a lease document says, for templates in the
// document service to be filled with (PLANO-FASE-7.md §3). The document
// service only substitutes flat fields, so every part that varies with the
// contract (agreement, amounts in words, the guarantee) is written here and
// handed over as a field.
//
// Each party is answered twice: as a ready paragraph (`locador_qualificacao`)
// and field by field, numbered per role (`locador_1_nome`, `locador_1_cpf`,
// `locador_2_nome`, up to MaxPartiesPerRole). The office asked for the second
// on 2026-09-17: a paragraph written here fits one model and no other, and a
// template has to be free to write its own sentence. `docs/campos.md` is the
// catalogue, and it must be updated whenever a name is added here.
type Documents struct {
	scope    OrganizationScope
	people   *People
	now      Clock
	location *time.Location
}

// DocumentsConfig collects the dependencies. People opens the sealed fields a
// qualification needs, and Location is where "today" is reckoned, since a
// document dated today is dated by the office's calendar.
type DocumentsConfig struct {
	Scope    OrganizationScope
	People   *People
	Now      Clock
	Location *time.Location
}

// NewDocuments wires the use case.
func NewDocuments(cfg DocumentsConfig) *Documents {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &Documents{
		scope:    cfg.Scope,
		people:   cfg.People,
		now:      cfg.Now,
		location: cfg.Location,
	}
}

// DocumentField is one field with its value, which may be empty when the
// register does not hold what it needs.
type DocumentField struct {
	Name  string
	Value string
}

// MaxPartiesPerRole is how many parties of one role get their own numbered
// fields. Four covers a couple on each side of a lease, or a property left to
// four heirs; beyond that the paragraph fields still name everybody.
const MaxPartiesPerRole = 4

// rolePrefixes are the roles a lease document names, in the order they appear.
var rolePrefixes = []string{"locador", "locatario", "fiador"}

// roleSuffixes is what every role answers about itself, as a whole.
var roleSuffixes = []string{
	"qualificacao", "nome", "titulo", "termo", "termo_inicio",
	"do", "ao", "no", "pelo", "o", "quantidade",
}

// contractFieldNames is everything that is not a party.
var contractFieldNames = []string{
	"contrato_numero", "escritorio_nome",
	"imovel_endereco", "imovel_logradouro", "imovel_numero", "imovel_complemento",
	"imovel_bairro", "imovel_cidade", "imovel_uf", "imovel_cep",
	"imovel_matricula", "imovel_cartorio", "imovel_iptu", "imovel_agua", "imovel_energia",
	"imovel_proprietarios",
	"aluguel_valor", "aluguel_valor_numero", "aluguel_extenso",
	"garantia_texto", "garantia_tipo",
	"caucao_valor", "caucao_valor_numero", "caucao_extenso", "caucao_alugueis",
	"prazo_meses", "prazo_meses_numero",
	"data_inicio", "data_inicio_extenso", "data_termino", "data_termino_extenso",
	"data_assinatura", "data_assinatura_extenso", "data_primeiro_reajuste",
	"data_rescisao", "hoje", "hoje_extenso",
	"indice_reajuste", "indice_reajuste_sigla",
	"vencimento_dia", "vencimento_dia_numero",
	"multa_atraso", "multa_atraso_numero",
	"juros_atraso", "juros_atraso_numero",
	"taxa_administracao", "taxa_administracao_numero",
	"promissorias_quantidade", "promissorias_periodo",
	"foro",
}

// DocumentFieldNames is every field, in the order they are listed. The list is
// part of the API's contract: templates are marked with these names.
var DocumentFieldNames = buildFieldNames()

func buildFieldNames() []string {
	names := make([]string, 0, 400)
	names = append(names, contractFieldNames...)
	for _, prefix := range rolePrefixes {
		for _, suffix := range roleSuffixes {
			names = append(names, prefix+"_"+suffix)
		}
		for i := 1; i <= MaxPartiesPerRole; i++ {
			for _, suffix := range domain.PersonFieldSuffixes {
				names = append(names, fmt.Sprintf("%s_%d_%s", prefix, i, suffix))
			}
		}
	}
	return names
}

var guaranteeNames = map[domain.GuaranteeKind]string{
	domain.GuaranteeNone:            "sem garantia",
	domain.GuaranteeDeposit:         "caução em dinheiro",
	domain.GuaranteeSurety:          "fiança",
	domain.GuaranteeSuretyInsurance: "seguro fiança",
	domain.GuaranteeFundAssignment:  "cessão fiduciária de quotas de fundo de investimento",
}

var indexAbbreviations = map[domain.AdjustmentIndex]string{
	"igpm":  "IGP-M",
	"ipca":  "IPCA",
	"inpc":  "INPC",
	"ivar":  "IVAR",
	"igpdi": "IGP-DI",
}

var indexNames = map[domain.AdjustmentIndex]string{
	"igpm":  "IGP-M/FGV",
	"ipca":  "IPCA/IBGE",
	"inpc":  "INPC/IBGE",
	"ivar":  "IVAR/FGV",
	"igpdi": "IGP-DI/FGV",
}

// ContractFields computes every field for one contract.
func (d *Documents) ContractFields(ctx context.Context, caller *Caller, contractID uuid.UUID) ([]DocumentField, error) {
	values := map[string]string{}
	err := d.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		contract, _, rents, err := repos.Contracts.Get(ctx, contractID)
		if err != nil {
			return err
		}
		property, _, err := repos.Properties.Get(ctx, contract.PropertyID)
		if err != nil {
			return err
		}

		// Every party, and the representatives of the companies among them.
		people := map[string]*domain.Person{}
		load := func(id uuid.UUID) (*domain.Person, error) {
			if p, ok := people[id.String()]; ok {
				return p, nil
			}
			stored, err := repos.People.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			p, err := d.people.open(stored)
			if err != nil {
				return nil, err
			}
			people[id.String()] = p
			return p, nil
		}
		byRole := map[domain.PartyRole][]*domain.Person{}
		for _, party := range contract.Parties {
			p, err := load(party.PersonID)
			if err != nil {
				return err
			}
			byRole[party.Role] = append(byRole[party.Role], p)
			// A company's representatives and an individual's spouse are named
			// by the fields, so they are opened as well.
			for _, rep := range p.RepresentativeIDs {
				if _, err := load(rep); err != nil {
					return err
				}
			}
			if p.SpouseID != nil {
				if _, err := load(*p.SpouseID); err != nil {
					return err
				}
			}
		}

		quals := func(list []*domain.Person, suffix string) []string {
			out := make([]string, 0, len(list))
			for _, p := range list {
				out = append(out, domain.Qualify(p, people)+suffix)
			}
			return out
		}
		names := func(list []*domain.Person) string {
			out := make([]string, 0, len(list))
			for _, p := range list {
				out = append(out, p.Name)
			}
			return domain.JoinNames(out)
		}
		role := func(prefix string, noun domain.RoleNoun, list []*domain.Person, qualifications []string) {
			values[prefix+"_qualificacao"] = domain.JoinParts(qualifications)
			values[prefix+"_nome"] = names(list)
			values[prefix+"_quantidade"] = fmt.Sprint(len(list))

			// Field by field, one block per party, so a template can write its
			// own sentence instead of taking the paragraph whole.
			for i, person := range list {
				if i >= MaxPartiesPerRole {
					break
				}
				for suffix, value := range domain.PersonFields(person, people) {
					values[fmt.Sprintf("%s_%d_%s", prefix, i+1, suffix)] = value
				}
			}

			if len(list) > 0 {
				values[prefix+"_termo"] = noun.Term(list)
				values[prefix+"_termo_inicio"] = noun.TermStart(list)
				values[prefix+"_titulo"] = noun.Title(list)
				values[prefix+"_do"] = noun.Contraction("de", list)
				values[prefix+"_ao"] = noun.Contraction("a", list)
				values[prefix+"_no"] = noun.Contraction("em", list)
				values[prefix+"_pelo"] = noun.Contraction("por", list)
				values[prefix+"_o"] = noun.Ending(list)
			}
		}
		landlords, tenants := byRole[domain.RoleLandlord], byRole[domain.RoleTenant]
		guarantors, spouses := byRole[domain.RoleGuarantor], byRole[domain.RoleGuarantorSpouse]
		role("locador", domain.NounLandlord, landlords, quals(landlords, ""))
		role("locatario", domain.NounTenant, tenants, quals(tenants, ""))
		role("fiador", domain.NounGuarantor, guarantors,
			append(quals(guarantors, ""), quals(spouses, ", na qualidade de cônjuge anuente")...))

		c := contract
		values["contrato_numero"] = c.Registry
		values["escritorio_nome"] = caller.Organization.Name

		address := property.Address
		values["imovel_endereco"] = domain.AddressText(address)
		values["imovel_logradouro"] = address.Street
		values["imovel_numero"] = address.Number
		values["imovel_complemento"] = address.Complement
		values["imovel_bairro"] = address.District
		values["imovel_cidade"] = address.City
		values["imovel_uf"] = address.State
		if len(address.ZipCode) == 8 {
			values["imovel_cep"] = address.ZipCode[:5] + "-" + address.ZipCode[5:]
		}
		values["imovel_matricula"] = property.Registry
		values["imovel_cartorio"] = property.RegistryOffice
		values["imovel_iptu"] = property.MunicipalRegistration
		values["imovel_agua"] = property.WaterCode
		values["imovel_energia"] = property.EnergyCode
		ownerNames := make([]string, 0, len(property.Owners))
		for _, owner := range property.Owners {
			person, err := load(owner.PersonID)
			if err != nil {
				return err
			}
			ownerNames = append(ownerNames, person.Name)
		}
		values["imovel_proprietarios"] = domain.JoinNames(ownerNames)
		if property.Address.City != "" && property.Address.State != "" {
			// The forum where the property is (Lei 8.245/91 art. 58, II),
			// editable when the document is reviewed.
			values["foro"] = property.Address.City + "/" + property.Address.State
		}

		// The rent as it stands today, adjustments included: a document signed
		// now says what is being charged now, not what the lease opened with.
		rent := c.CurrentRent
		values["aluguel_valor"] = domain.MoneyText(rent)
		values["aluguel_valor_numero"] = domain.MoneyNumberText(rent)
		values["aluguel_extenso"] = domain.MoneyInWords(rent)
		values["garantia_texto"] = guaranteeText(c, values["fiador_qualificacao"])
		values["garantia_tipo"] = guaranteeNames[c.GuaranteeKind]
		if c.GuaranteeKind == domain.GuaranteeDeposit {
			values["caucao_valor"] = domain.MoneyText(c.DepositAmount)
			values["caucao_valor_numero"] = domain.MoneyNumberText(c.DepositAmount)
			values["caucao_extenso"] = domain.MoneyInWords(c.DepositAmount)
			if c.Rent > 0 && c.DepositAmount%c.Rent == 0 {
				values["caucao_alugueis"] = domain.CountText(int(c.DepositAmount/c.Rent), false)
			}
		}

		months := domain.TermMonths(c.StartsOn, c.ExpiresOn)
		unit := "meses"
		if months == 1 {
			unit = "mês"
		}
		values["prazo_meses"] = domain.CountText(months, false) + " " + unit
		values["prazo_meses_numero"] = fmt.Sprint(months)
		values["data_inicio"] = domain.DateText(c.StartsOn)
		values["data_inicio_extenso"] = domain.DateLongText(c.StartsOn)
		values["data_termino"] = domain.DateText(c.ExpiresOn)
		values["data_termino_extenso"] = domain.DateLongText(c.ExpiresOn)
		values["data_primeiro_reajuste"] = domain.DateText(c.StartsOn.AddMonths(12))
		values["data_assinatura"] = domain.DateText(c.SignedOn)
		values["data_assinatura_extenso"] = domain.DateLongText(c.SignedOn)
		if c.TerminatedOn != nil {
			values["data_rescisao"] = domain.DateText(*c.TerminatedOn)
		}
		today := domain.DateOf(d.now(), d.location)
		values["hoje"] = domain.DateText(today)
		values["hoje_extenso"] = domain.DateLongText(today)
		values["indice_reajuste"] = indexNames[c.AdjustmentIndex]
		values["indice_reajuste_sigla"] = indexAbbreviations[c.AdjustmentIndex]
		values["vencimento_dia"] = domain.CountText(c.DueDay, false)
		values["vencimento_dia_numero"] = fmt.Sprint(c.DueDay)
		values["multa_atraso"] = domain.PercentText(c.LatePenaltyRate)
		values["multa_atraso_numero"] = domain.RateNumberText(c.LatePenaltyRate)
		values["juros_atraso"] = domain.PercentText(c.LateInterestRate) + " ao mês"
		values["juros_atraso_numero"] = domain.RateNumberText(c.LateInterestRate)
		values["taxa_administracao"] = domain.PercentText(c.AdminFee)
		values["taxa_administracao_numero"] = domain.RateNumberText(c.AdminFee)
		if len(rents) > 0 {
			values["promissorias_quantidade"] = domain.CountText(len(rents), true)
			values["promissorias_periodo"] = domain.MonthYearText(rents[0].DueOn) + " a " +
				domain.MonthYearText(rents[len(rents)-1].DueOn)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]DocumentField, 0, len(DocumentFieldNames))
	for _, name := range DocumentFieldNames {
		out = append(out, DocumentField{Name: name, Value: values[name]})
	}
	return out, nil
}

// guaranteeText is the sentence that states the guarantee. It says what the
// guarantee is; what happens to it is the template's own clause.
func guaranteeText(c *domain.Contract, guarantors string) string {
	switch c.GuaranteeKind {
	case domain.GuaranteeDeposit:
		text := "Caução em dinheiro no valor de " + domain.MoneyText(c.DepositAmount) +
			" (" + domain.MoneyInWords(c.DepositAmount) + ")"
		if c.Rent > 0 && c.DepositAmount%c.Rent == 0 {
			n := int(c.DepositAmount / c.Rent)
			unit := " aluguéis"
			if n == 1 {
				unit = " aluguel"
			}
			text += ", correspondente a " + domain.CountText(n, false) + unit
		}
		return text + "."
	case domain.GuaranteeSurety:
		return "Fiança prestada por " + guarantors + "."
	case domain.GuaranteeSuretyInsurance:
		return "Seguro fiança locatícia."
	case domain.GuaranteeFundAssignment:
		return "Cessão fiduciária de quotas de fundo de investimento."
	}
	return "Locação sem garantia."
}
