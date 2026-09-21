package http

import (
	"encoding/base64"
	json "encoding/json/v2"
	"net/http"
	"strconv"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// entryBody is a ledger line. Amount is positive; Signed is its effect on the
// balance, so a client sums lines without knowing which kinds deduct.
type entryBody struct {
	ID          string               `json:"id"`
	PersonID    string               `json:"person_id"`
	Kind        domain.EntryKind     `json:"kind"`
	Amount      domain.Money         `json:"amount"`
	Signed      domain.Money         `json:"signed"`
	OccurredOn  domain.Date          `json:"occurred_on"`
	Description string               `json:"description"`
	PropertyID  *string              `json:"property_id"`
	Address     *propertyAddressBody `json:"address"`
	ContractID  *string              `json:"contract_id"`
	Registry    string               `json:"registry,omitzero"`
	RentID      *string              `json:"rent_id"`
	Rent        *entryRentBody       `json:"rent,omitzero"`
	ChargeID    *string              `json:"charge_id"`
	Charge      *entryChargeBody     `json:"charge,omitzero"`
	PayoutID    *string              `json:"payout_id"`
}

type entryRentBody struct {
	Sequence int         `json:"sequence"`
	DueOn    domain.Date `json:"due_on"`
}

type entryChargeBody struct {
	Kind        domain.ChargeKind `json:"kind"`
	Description string            `json:"description"`
}

func idText(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	s := id.String()
	return &s
}

func presentEntry(e *domain.LedgerEntry) entryBody {
	return entryBody{
		ID: e.ID.String(), PersonID: e.PersonID.String(), Kind: e.Kind, Amount: e.Amount,
		Signed: domain.Money(e.Signed()), OccurredOn: e.OccurredOn, Description: e.Description,
		PropertyID: idText(e.PropertyID), ContractID: idText(e.ContractID), RentID: idText(e.RentID),
		ChargeID: idText(e.ChargeID), PayoutID: idText(e.PayoutID),
	}
}

func presentEntryView(v *usecase.EntryView) entryBody {
	out := presentEntry(&v.LedgerEntry)
	if v.Address != nil {
		a := presentPropertyAddress(*v.Address)
		out.Address = &a
	}
	out.Registry = v.Registry
	if v.RentDueOn != nil {
		out.Rent = &entryRentBody{Sequence: v.RentSequence, DueOn: *v.RentDueOn}
	}
	if v.ChargeKind != "" {
		out.Charge = &entryChargeBody{Kind: v.ChargeKind, Description: v.ChargeDescription}
	}
	return out
}

func presentEntryViews(views []usecase.EntryView) []entryBody {
	out := make([]entryBody, 0, len(views))
	for i := range views {
		out = append(out, presentEntryView(&views[i]))
	}
	return out
}

type personRefBody struct {
	ID   string            `json:"id"`
	Name string            `json:"name"`
	Kind domain.PersonKind `json:"kind"`
}

type balanceBody struct {
	Person   personRefBody `json:"person"`
	Pending  domain.Money  `json:"pending"`
	Lines    int           `json:"lines"`
	OldestOn domain.Date   `json:"oldest_on"`
}

func (s *Server) handleBalances(w http.ResponseWriter, r *http.Request) {
	balances, err := s.payouts.Balances(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := struct {
		Balances []balanceBody `json:"balances"`
	}{Balances: make([]balanceBody, 0, len(balances))}
	for _, b := range balances {
		out.Balances = append(out.Balances, balanceBody{
			Person:  personRefBody{ID: b.PersonID.String(), Name: b.Name, Kind: b.Kind},
			Pending: domain.Money(b.Pending), Lines: b.Lines, OldestOn: b.OldestOn,
		})
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) personID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := requiredUUID("person_id", r.PathValue("personID"))
	if err != nil {
		writeError(w, s.logger, err)
		return uuid.UUID{}, false
	}
	return id, true
}

func (s *Server) handlePersonLedger(w http.ResponseWriter, r *http.Request) {
	id, ok := s.personID(w, r)
	if !ok {
		return
	}
	l, err := s.payouts.Ledger(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, struct {
		Person  personRefBody `json:"person"`
		Balance domain.Money  `json:"balance"`
		Pending []entryBody   `json:"pending"`
		Today   domain.Date   `json:"today"`
	}{
		Person:  personRefBody{ID: l.Person.ID.String(), Name: l.Person.Name, Kind: l.Person.Kind},
		Balance: domain.Money(l.Balance), Pending: presentEntryViews(l.Pending), Today: l.Today,
	})
}

func (s *Server) handleAddLedgerEntry(w http.ResponseWriter, r *http.Request) {
	id, ok := s.personID(w, r)
	if !ok {
		return
	}
	var body struct {
		Kind        string `json:"kind"`
		Amount      string `json:"amount"`
		Description string `json:"description"`
		OccurredOn  string `json:"occurred_on"`
		PropertyID  string `json:"property_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	v := &domain.ValidationError{}
	e := &domain.LedgerEntry{Kind: domain.EntryKind(body.Kind), Description: body.Description}
	if m, err := domain.ParseMoney(body.Amount); err == nil {
		e.Amount = m
	} else {
		v.Add("amount", "must be an amount such as 1500.00")
	}
	if d := optionalDate("occurred_on", body.OccurredOn, v); d != nil {
		e.OccurredOn = *d
	}
	if body.PropertyID != "" {
		if pid, err := uuid.Parse(body.PropertyID); err == nil {
			e.PropertyID = &pid
		} else {
			v.Add("property_id", "is not a valid identifier")
		}
	}
	if err := v.OrNil(); err != nil {
		writeError(w, s.logger, err)
		return
	}
	created, err := s.payouts.AddEntry(r.Context(), callerFrom(r.Context()), id, e)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, presentEntry(created))
}

func (s *Server) handleDeleteLedgerEntry(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("entry_id", r.PathValue("entryID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.payouts.DeleteEntry(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type payoutBody struct {
	ID        string              `json:"id"`
	Number    string              `json:"number"`
	Person    personRefBody       `json:"person"`
	PaidOn    domain.Date         `json:"paid_on"`
	Total     domain.Money        `json:"total"`
	Method    domain.PayoutMethod `json:"method"`
	Note      string              `json:"note"`
	CreatedAt time.Time           `json:"created_at"`
}

func presentPayout(p *usecase.PayoutSummary) payoutBody {
	return payoutBody{
		ID: p.ID.String(), Number: p.Number(),
		Person: personRefBody{ID: p.PersonID.String(), Name: p.PersonName, Kind: p.PersonKind},
		PaidOn: p.PaidOn, Total: p.Total, Method: p.Method, Note: p.Note,
		CreatedAt: p.CreatedAt,
	}
}

type payoutDetailBody struct {
	payoutBody
	Entries []entryBody `json:"entries"`
}

func writePayout(w http.ResponseWriter, s *Server, status int, d *usecase.PayoutDetail) {
	writeJSON(w, s.logger, status, payoutDetailBody{
		payoutBody: presentPayout(&d.Payout),
		Entries:    presentEntryViews(d.Entries),
	})
}

func (s *Server) handleCreatePayout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PersonID string   `json:"person_id"`
		PaidOn   string   `json:"paid_on"`
		EntryIDs []string `json:"entry_ids"`
		Method   string   `json:"method"`
		Note     string   `json:"note"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	v := &domain.ValidationError{}
	in := usecase.PayoutInput{Method: domain.PayoutMethod(body.Method), Note: body.Note}
	if id, err := uuid.Parse(body.PersonID); err == nil {
		in.PersonID = id
	} else {
		v.Add("person_id", "is not a valid identifier")
	}
	if d := optionalDate("paid_on", body.PaidOn, v); d != nil {
		in.PaidOn = *d
	}
	for i, raw := range body.EntryIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			v.Add("entry_ids["+strconv.Itoa(i)+"]", "is not a valid identifier")
			continue
		}
		in.EntryIDs = append(in.EntryIDs, id)
	}
	if err := v.OrNil(); err != nil {
		writeError(w, s.logger, err)
		return
	}
	d, err := s.payouts.Create(r.Context(), callerFrom(r.Context()), in)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writePayout(w, s, http.StatusCreated, d)
}

func (s *Server) payoutID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := requiredUUID("payout_id", r.PathValue("payoutID"))
	if err != nil {
		writeError(w, s.logger, err)
		return uuid.UUID{}, false
	}
	return id, true
}

func (s *Server) handleGetPayout(w http.ResponseWriter, r *http.Request) {
	id, ok := s.payoutID(w, r)
	if !ok {
		return
	}
	d, err := s.payouts.Get(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writePayout(w, s, http.StatusOK, d)
}

func (s *Server) handleUndoPayout(w http.ResponseWriter, r *http.Request) {
	id, ok := s.payoutID(w, r)
	if !ok {
		return
	}
	if err := s.payouts.Undo(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListPayouts(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	v := &domain.ValidationError{}
	var q usecase.PayoutQuery
	if raw := query.Get("person_id"); raw != "" {
		if id, err := uuid.Parse(raw); err == nil {
			q.PersonID = &id
		} else {
			v.Add("person_id", "is not a valid identifier")
		}
	}
	if raw := query.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			q.Limit = n
		} else {
			v.Add("limit", "must be a positive integer")
		}
	}
	if raw := query.Get("cursor"); raw != "" {
		cursor, err := decodeCursor(raw)
		if err != nil {
			writeError(w, s.logger, err)
			return
		}
		paid, err := domain.ParseDate(cursor.SortKey)
		if err != nil {
			v.Add("cursor", "is not a cursor this API issued")
		} else {
			q.After = &usecase.PayoutCursor{PaidOn: paid, ID: cursor.ID}
		}
	}
	if err := v.OrNil(); err != nil {
		writeError(w, s.logger, err)
		return
	}
	page, err := s.payouts.List(r.Context(), callerFrom(r.Context()), q)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := struct {
		Payouts    []payoutBody `json:"payouts"`
		NextCursor string       `json:"next_cursor,omitzero"`
	}{Payouts: make([]payoutBody, 0, len(page.Payouts))}
	for i := range page.Payouts {
		out.Payouts = append(out.Payouts, presentPayout(&page.Payouts[i]))
	}
	if page.Next != nil {
		raw, _ := json.Marshal(cursorBody{Key: page.Next.PaidOn.String(), ID: page.Next.ID.String()})
		out.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

// --- carnê-leão report -----------------------------------------------------------

type incomeFiguresBody struct {
	Rent      domain.Money `json:"rent"`
	LateFee   domain.Money `json:"late_fee"`
	Charges   domain.Money `json:"charges"`
	AdminFee  domain.Money `json:"admin_fee"`
	IncomeTax domain.Money `json:"income_tax"`
}

type incomeMonthBody struct {
	Month      int               `json:"month,omitzero"`
	Individual incomeFiguresBody `json:"individual"`
	Company    incomeFiguresBody `json:"company"`
	Debits     domain.Money      `json:"debits"`
	Credits    domain.Money      `json:"credits"`
}

func presentIncomeFigures(f usecase.IncomeFigures) incomeFiguresBody {
	return incomeFiguresBody{Rent: f.Rent, LateFee: f.LateFee, Charges: f.Charges, AdminFee: f.AdminFee, IncomeTax: f.IncomeTax}
}

func presentIncomeMonth(m usecase.IncomeMonth) incomeMonthBody {
	return incomeMonthBody{
		Month: m.Month, Individual: presentIncomeFigures(m.Individual), Company: presentIncomeFigures(m.Company),
		Debits: m.Debits, Credits: m.Credits,
	}
}

func (s *Server) handleIncomeReport(w http.ResponseWriter, r *http.Request) {
	id, ok := s.personID(w, r)
	if !ok {
		return
	}
	year, err := strconv.Atoi(r.URL.Query().Get("year"))
	if err != nil {
		v := &domain.ValidationError{}
		v.Add("year", "must be a year such as 2026")
		writeError(w, s.logger, v)
		return
	}
	report, err := s.payouts.IncomeReport(r.Context(), callerFrom(r.Context()), id, year)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := struct {
		Person personRefBody     `json:"person"`
		Year   int               `json:"year"`
		Months []incomeMonthBody `json:"months"`
		Total  incomeMonthBody   `json:"total"`
	}{
		Person: personRefBody{ID: report.Person.ID.String(), Name: report.Person.Name, Kind: report.Person.Kind},
		Year:   report.Year, Months: make([]incomeMonthBody, 0, len(report.Months)), Total: presentIncomeMonth(report.Total),
	}
	for _, m := range report.Months {
		out.Months = append(out.Months, presentIncomeMonth(m))
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}
