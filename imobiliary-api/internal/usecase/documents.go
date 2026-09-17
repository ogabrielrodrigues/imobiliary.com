package usecase

import (
	"context"
	"uuid"

	"imobiliary/internal/domain"
)

// Documents computes what a lease document says, for templates in the
// document service to be filled with (PLANO-FASE-7.md §3). The document
// service only substitutes flat fields, so every part that varies with the
// contract (qualifications, agreement, amounts in words, the guarantee) is
// written here and handed over as one field.
type Documents struct {
	scope  OrganizationScope
	people *People
}

// DocumentsConfig collects the dependencies. People opens the sealed fields a
// qualification needs.
type DocumentsConfig struct {
	Scope  OrganizationScope
	People *People
}

// NewDocuments wires the use case.
func NewDocuments(cfg DocumentsConfig) *Documents {
	return &Documents{scope: cfg.Scope, people: cfg.People}
}

// DocumentField is one field with its value, which may be empty when the
// register does not hold what it needs.
type DocumentField struct {
	Name  string
	Value string
}

// DocumentFieldNames is every field, in the order they are listed. The list is
// part of the API's contract: templates are marked with these names.
var DocumentFieldNames = []string{
	"contrato_numero",
	"locador_qualificacao", "locador_nome", "locador_titulo", "locador_termo", "locador_termo_inicio",
	"locador_do", "locador_ao", "locador_no", "locador_pelo", "locador_o",
	"locatario_qualificacao", "locatario_nome", "locatario_titulo", "locatario_termo", "locatario_termo_inicio",
	"locatario_do", "locatario_ao", "locatario_no", "locatario_pelo", "locatario_o",
	"fiador_qualificacao", "fiador_nome", "fiador_titulo", "fiador_termo", "fiador_termo_inicio",
	"fiador_do", "fiador_ao", "fiador_no", "fiador_pelo", "fiador_o",
	"imovel_endereco", "imovel_matricula", "imovel_cartorio", "imovel_iptu",
	"aluguel_valor", "aluguel_extenso",
	"garantia_texto", "caucao_valor", "caucao_extenso", "caucao_alugueis",
	"prazo_meses", "data_inicio", "data_termino", "data_primeiro_reajuste", "data_assinatura_extenso",
	"indice_reajuste", "vencimento_dia", "multa_atraso", "juros_atraso", "taxa_administracao",
	"promissorias_quantidade", "promissorias_periodo",
	"foro",
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
			for _, rep := range p.RepresentativeIDs {
				if _, err := load(rep); err != nil {
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
		values["imovel_endereco"] = domain.AddressText(property.Address)
		values["imovel_matricula"] = property.Registry
		values["imovel_cartorio"] = property.RegistryOffice
		values["imovel_iptu"] = property.MunicipalRegistration
		if property.Address.City != "" && property.Address.State != "" {
			// The forum where the property is (Lei 8.245/91 art. 58, II),
			// editable when the document is reviewed.
			values["foro"] = property.Address.City + "/" + property.Address.State
		}

		values["aluguel_valor"] = domain.MoneyText(c.Rent)
		values["aluguel_extenso"] = domain.MoneyInWords(c.Rent)
		values["garantia_texto"] = guaranteeText(c, values["fiador_qualificacao"])
		if c.GuaranteeKind == domain.GuaranteeDeposit {
			values["caucao_valor"] = domain.MoneyText(c.DepositAmount)
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
		values["data_inicio"] = domain.DateText(c.StartsOn)
		values["data_termino"] = domain.DateText(c.ExpiresOn)
		values["data_primeiro_reajuste"] = domain.DateText(c.StartsOn.AddMonths(12))
		values["data_assinatura_extenso"] = domain.DateLongText(c.SignedOn)
		values["indice_reajuste"] = indexNames[c.AdjustmentIndex]
		values["vencimento_dia"] = domain.CountText(c.DueDay, false)
		values["multa_atraso"] = domain.PercentText(c.LatePenaltyRate)
		values["juros_atraso"] = domain.PercentText(c.LateInterestRate) + " ao mês"
		values["taxa_administracao"] = domain.PercentText(c.AdminFee)
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
