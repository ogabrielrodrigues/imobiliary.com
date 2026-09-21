package usecase

import (
	"context"
	"fmt"
	"uuid"

	"imobiliary/internal/domain"
)

// The fields a payout statement is filled with (PLANO-REPASSE.md §6), for a
// template in the document service, as a contract has its own. The document
// service has no loop, so a statement cannot walk a list of any length: it
// gets the payout, the beneficiary field by field, the administrator, the
// totals by kind, and each property numbered up to MaxPayoutProperties. The
// full detail, line by line, is the platform's own statement and receipt.

// MaxPayoutProperties is how many properties a statement numbers. Beyond it
// the totals still cover everything.
const MaxPayoutProperties = 10

var payoutFieldNames = []string{
	"repasse_numero", "repasse_data", "repasse_data_extenso",
	"repasse_total", "repasse_total_numero", "repasse_total_extenso",
	"repasse_forma", "repasse_observacao",
	"escritorio_nome", "administrador_nome", "administrador_tipo", "administrador_documento", "administrador_creci",
	"total_alugueis", "total_multas", "total_cobrancas", "total_creditos",
	"total_taxa", "total_irrf", "total_debitos",
	"imoveis_quantidade", "hoje", "hoje_extenso",
}

// payoutPropertySuffixes is what each numbered property answers.
var payoutPropertySuffixes = []string{"endereco", "aluguel", "multas", "cobrancas", "taxa", "irrf", "liquido"}

// PayoutFieldNames is every field of a payout statement, in order.
var PayoutFieldNames = buildPayoutFieldNames()

func buildPayoutFieldNames() []string {
	names := append([]string{}, payoutFieldNames...)
	for _, suffix := range domain.PersonFieldSuffixes {
		names = append(names, "proprietario_"+suffix)
	}
	for i := 1; i <= MaxPayoutProperties; i++ {
		for _, suffix := range payoutPropertySuffixes {
			names = append(names, fmt.Sprintf("imovel_%d_%s", i, suffix))
		}
	}
	return names
}

var payoutMethodNames = map[domain.PayoutMethod]string{
	domain.PayoutPix:      "PIX",
	domain.PayoutTransfer: "transferência bancária",
	domain.PayoutCash:     "dinheiro",
	domain.PayoutCheck:    "cheque",
	domain.PayoutOther:    "outra forma",
}

// kindTotals sums lines by kind, each positive.
func kindTotals(entries []EntryView) map[domain.EntryKind]domain.Money {
	out := map[domain.EntryKind]domain.Money{}
	for i := range entries {
		out[entries[i].Kind] += entries[i].Amount
	}
	return out
}

// PayoutFields answers every field of a payout statement.
func (d *Documents) PayoutFields(ctx context.Context, caller *Caller, payoutID uuid.UUID) ([]DocumentField, error) {
	values := map[string]string{}
	err := d.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		payout, err := repos.Ledger.Payout(ctx, payoutID)
		if err != nil {
			return err
		}
		entries, err := repos.Ledger.PayoutEntries(ctx, payoutID)
		if err != nil {
			return err
		}

		// The beneficiary, with whoever their fields name.
		people := map[string]*domain.Person{}
		open := func(id uuid.UUID) (*domain.Person, error) {
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
		owner, err := open(payout.PersonID)
		if err != nil {
			return err
		}
		for _, rep := range owner.RepresentativeIDs {
			if _, err := open(rep); err != nil {
				return err
			}
		}
		if owner.SpouseID != nil {
			if _, err := open(*owner.SpouseID); err != nil {
				return err
			}
		}
		for suffix, value := range domain.PersonFields(owner, people) {
			values["proprietario_"+suffix] = value
		}

		values["repasse_numero"] = payout.Number()
		values["repasse_data"] = domain.DateText(payout.PaidOn)
		values["repasse_data_extenso"] = domain.DateLongText(payout.PaidOn)
		values["repasse_total"] = domain.MoneyText(payout.Total)
		values["repasse_total_numero"] = domain.MoneyNumberText(payout.Total)
		values["repasse_total_extenso"] = domain.MoneyInWords(payout.Total)
		values["repasse_forma"] = payoutMethodNames[payout.Method]
		values["repasse_observacao"] = payout.Note

		totals := kindTotals(entries)
		for field, kind := range map[string]domain.EntryKind{
			"total_alugueis": domain.EntryRent, "total_multas": domain.EntryLateFee, "total_cobrancas": domain.EntryCharge,
			"total_creditos": domain.EntryCredit, "total_taxa": domain.EntryAdminFee, "total_irrf": domain.EntryIncomeTax,
			"total_debitos": domain.EntryDebit,
		} {
			values[field] = domain.MoneyText(totals[kind])
		}

		// Each property in the order the statement lists them.
		var order []uuid.UUID
		byProperty := map[uuid.UUID][]EntryView{}
		for _, e := range entries {
			if e.PropertyID == nil {
				continue
			}
			id := *e.PropertyID
			if _, seen := byProperty[id]; !seen {
				order = append(order, id)
			}
			byProperty[id] = append(byProperty[id], e)
		}
		values["imoveis_quantidade"] = fmt.Sprint(len(order))
		for i, id := range order {
			if i >= MaxPayoutProperties {
				break
			}
			lines := byProperty[id]
			t := kindTotals(lines)
			var net int64
			for j := range lines {
				net += lines[j].Signed()
			}
			prefix := fmt.Sprintf("imovel_%d_", i+1)
			if lines[0].Address != nil {
				values[prefix+"endereco"] = domain.AddressText(*lines[0].Address)
			}
			values[prefix+"aluguel"] = domain.MoneyText(t[domain.EntryRent])
			values[prefix+"multas"] = domain.MoneyText(t[domain.EntryLateFee])
			values[prefix+"cobrancas"] = domain.MoneyText(t[domain.EntryCharge])
			values[prefix+"taxa"] = domain.MoneyText(t[domain.EntryAdminFee])
			values[prefix+"irrf"] = domain.MoneyText(t[domain.EntryIncomeTax])
			values[prefix+"liquido"] = domain.MoneyText(domain.Money(net))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	values["escritorio_nome"] = caller.Organization.Name
	values["administrador_nome"] = caller.Organization.Name
	if d.organizations != nil {
		admin, err := d.organizations.Administrator(ctx, caller)
		if err != nil {
			return nil, err
		}
		if admin != nil {
			values["administrador_documento"] = admin.FormattedDocument()
			values["administrador_creci"] = admin.CRECI
			values["administrador_tipo"] = "Pessoa física"
			if admin.Kind == domain.AdministratorCompany {
				values["administrador_tipo"] = "Pessoa jurídica"
			}
		}
	}
	today := domain.DateOf(d.now(), d.location)
	values["hoje"] = domain.DateText(today)
	values["hoje_extenso"] = domain.DateLongText(today)

	out := make([]DocumentField, 0, len(PayoutFieldNames))
	for _, name := range PayoutFieldNames {
		out = append(out, DocumentField{Name: name, Value: values[name]})
	}
	return out, nil
}
