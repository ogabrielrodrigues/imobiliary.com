package http

import (
	"encoding/base64"
	json "encoding/json/v2"
	"net/http"
	"strconv"
	"strings"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

type rentContractBody struct {
	ID          string              `json:"id"`
	Registry    string              `json:"registry"`
	Address     propertyAddressBody `json:"address"`
	TenantNames []string            `json:"tenant_names"`
}

type chargeBody struct {
	ID          string                   `json:"id"`
	Kind        domain.ChargeKind        `json:"kind"`
	Description string                   `json:"description"`
	Amount      domain.Money             `json:"amount"`
	Destination domain.ChargeDestination `json:"destination"`
}

type lateFeeBody struct {
	DaysLate int          `json:"days_late"`
	Penalty  domain.Money `json:"penalty"`
	Interest domain.Money `json:"interest"`
	Total    domain.Money `json:"total"`
}

func presentLateFee(f domain.LateFee) lateFeeBody {
	return lateFeeBody{DaysLate: f.DaysLate, Penalty: f.Penalty, Interest: f.Interest, Total: f.Total}
}

type rentViewBody struct {
	ID           string           `json:"id"`
	Contract     rentContractBody `json:"contract"`
	Sequence     int              `json:"sequence"`
	DueOn        domain.Date      `json:"due_on"`
	Amount       domain.Money     `json:"amount"`
	ChargesTotal domain.Money     `json:"charges_total"`
	// Due is the rent with its charges, before any late fee.
	Due        domain.Money  `json:"due"`
	LateFee    domain.Money  `json:"late_fee"`
	AmountPaid *domain.Money `json:"amount_paid"`
	PaidOn     *domain.Date  `json:"paid_on"`
	// IncomeTaxWithheld is what a company tenant kept, deducted from the
	// amount received and from the owners' payout.
	IncomeTaxWithheld domain.Money `json:"income_tax_withheld"`
	// PrincipalPaid is the part of the rent and charges already settled, and
	// Outstanding the part still open. PartiallyPaid is true while money came
	// in and something is still open; the status stays pending or overdue.
	PrincipalPaid domain.Money `json:"principal_paid"`
	Outstanding   domain.Money `json:"outstanding"`
	PartiallyPaid bool         `json:"partially_paid"`
	Status        string       `json:"status"`
}

type rentPaymentBody struct {
	ID        string       `json:"id"`
	PaidOn    domain.Date  `json:"paid_on"`
	Amount    domain.Money `json:"amount"`
	LateFee   domain.Money `json:"late_fee"`
	Waived    domain.Money `json:"waived"`
	Principal domain.Money `json:"principal"`
	IncomeTax domain.Money `json:"income_tax_withheld"`
}

type rentDetailBody struct {
	rentViewBody
	Charges  []chargeBody      `json:"charges"`
	Payments []rentPaymentBody `json:"payments"`
	// SuggestedLateFee is the interest and penalty owed today; zero once paid.
	SuggestedLateFee lateFeeBody `json:"suggested_late_fee"`
	// OwedToday is everything owed today: the principal still open with the
	// interest and penalty; zero once paid.
	OwedToday domain.Money `json:"owed_today"`
}

func presentRentView(r *usecase.RentView, today domain.Date) rentViewBody {
	status := "pending"
	switch {
	case r.PaidOn != nil:
		status = "paid"
	case r.DueOn.Before(today):
		status = "overdue"
	}
	names := r.TenantNames
	if names == nil {
		names = []string{}
	}
	return rentViewBody{
		ID: r.ID.String(),
		Contract: rentContractBody{
			ID: r.ContractID.String(), Registry: r.Registry, Address: presentPropertyAddress(r.Address), TenantNames: names,
		},
		Sequence: r.Sequence, DueOn: r.DueOn, Amount: r.Amount, ChargesTotal: r.ChargesTotal, Due: r.Due(),
		LateFee: r.LateFee, AmountPaid: r.AmountPaid, PaidOn: r.PaidOn, IncomeTaxWithheld: r.IncomeTaxWithheld,
		PrincipalPaid: r.PrincipalPaid, Outstanding: r.Outstanding(), PartiallyPaid: r.PartiallyPaid(), Status: status,
	}
}

func writeRent(w http.ResponseWriter, s *Server, status int, d *usecase.RentDetail) {
	out := rentDetailBody{
		rentViewBody:     presentRentView(d.Rent, d.Today),
		Charges:          make([]chargeBody, 0, len(d.Rent.Charges)),
		Payments:         make([]rentPaymentBody, 0, len(d.Rent.Payments)),
		SuggestedLateFee: presentLateFee(d.Suggested),
		OwedToday:        d.Standing.Total(),
	}
	for _, p := range d.Rent.Payments {
		out.Payments = append(out.Payments, rentPaymentBody{
			ID: p.ID.String(), PaidOn: p.PaidOn, Amount: p.Amount, LateFee: p.LateFee, Waived: p.Waived,
			Principal: p.Principal, IncomeTax: p.IncomeTax,
		})
	}
	for _, c := range d.Rent.Charges {
		out.Charges = append(out.Charges, chargeBody{
			ID: c.ID.String(), Kind: c.Kind, Description: c.Description, Amount: c.Amount, Destination: c.Destination,
		})
	}
	writeJSON(w, s.logger, status, out)
}

type rentsPageBody struct {
	Rents      []rentViewBody `json:"rents"`
	NextCursor string         `json:"next_cursor,omitzero"`
}

func optionalDate(field, raw string, v *domain.ValidationError) *domain.Date {
	if raw == "" {
		return nil
	}
	d, err := domain.ParseDate(raw)
	if err != nil {
		v.Add(field, "must be a date written YYYY-MM-DD")
		return nil
	}
	return &d
}

func (s *Server) handleListRents(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	v := &domain.ValidationError{}
	q := usecase.RentQuery{
		Search:  strings.TrimSpace(query.Get("q")),
		Status:  query.Get("status"),
		DueFrom: optionalDate("due_from", query.Get("due_from"), v),
		DueTo:   optionalDate("due_to", query.Get("due_to"), v),
	}
	if raw := query.Get("contract_id"); raw != "" {
		if id, err := uuid.Parse(raw); err == nil {
			q.ContractID = &id
		} else {
			v.Add("contract_id", "is not a valid identifier")
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
		due, err := domain.ParseDate(cursor.SortKey)
		if err != nil {
			v.Add("cursor", "is not a cursor this API issued")
		} else {
			q.After = &usecase.RentCursor{DueOn: due, ID: cursor.ID}
		}
	}
	if err := v.OrNil(); err != nil {
		writeError(w, s.logger, err)
		return
	}

	page, err := s.rents.List(r.Context(), callerFrom(r.Context()), q)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := rentsPageBody{Rents: make([]rentViewBody, 0, len(page.Rents))}
	for i := range page.Rents {
		out.Rents = append(out.Rents, presentRentView(&page.Rents[i], page.Today))
	}
	if page.Next != nil {
		raw, _ := json.Marshal(cursorBody{Key: page.Next.DueOn.String(), ID: page.Next.ID.String()})
		out.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) rentID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := requiredUUID("rent_id", r.PathValue("rentID"))
	if err != nil {
		writeError(w, s.logger, err)
		return uuid.UUID{}, false
	}
	return id, true
}

func (s *Server) handleGetRent(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	d, err := s.rents.Get(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusOK, d)
}

type paymentRequest struct {
	PaidOn string `json:"paid_on"`
	// Amount is what came in, for a partial payment; empty settles everything
	// owed on the day, computed.
	Amount  string `json:"amount"`
	LateFee string `json:"late_fee"`
	// IncomeTaxWithheld is what a company tenant kept; empty is none.
	IncomeTaxWithheld string `json:"income_tax_withheld"`
	// AmountPaid is not accepted: a payment in full is computed, and a partial
	// one is sent as amount. It stays in the shape so a client that still
	// sends it is told so rather than ignored.
	AmountPaid string `json:"amount_paid"`
}

func (body paymentRequest) toInput() (usecase.PaymentInput, error) {
	v := &domain.ValidationError{}
	var in usecase.PaymentInput
	if d := optionalDate("paid_on", body.PaidOn, v); d != nil {
		in.PaidOn = *d
	} else if body.PaidOn == "" {
		v.Add("paid_on", "is required")
	}
	if body.AmountPaid != "" {
		v.Add("amount_paid", "is computed: the rent, its charges and the late fee, less the tax withheld; send amount for a partial payment")
	}
	if body.Amount != "" {
		if m, err := domain.ParseMoney(body.Amount); err == nil {
			in.Amount = &m
		} else {
			v.Add("amount", "must be an amount such as 1500.00")
		}
	}
	if body.LateFee != "" {
		if m, err := domain.ParseMoney(body.LateFee); err == nil {
			in.LateFee = &m
		} else {
			v.Add("late_fee", "must be an amount such as 1500.00")
		}
	}
	if body.IncomeTaxWithheld != "" {
		if m, err := domain.ParseMoney(body.IncomeTaxWithheld); err == nil {
			in.IncomeTax = m
		} else {
			v.Add("income_tax_withheld", "must be an amount such as 1500.00")
		}
	}
	return in, v.OrNil()
}

type paymentPreviewBody struct {
	LateFee   lateFeeBody  `json:"late_fee"`
	Principal domain.Money `json:"principal"`
	Total     domain.Money `json:"total"`
}

func (s *Server) handlePreviewPayment(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	var body paymentRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	in, err := body.toInput()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	preview, err := s.rents.PreviewPayment(r.Context(), callerFrom(r.Context()), id, in.PaidOn)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, paymentPreviewBody{LateFee: presentLateFee(preview.LateFee), Principal: preview.Principal, Total: preview.Total})
}

func (s *Server) handlePayRent(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	var body paymentRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	in, err := body.toInput()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	d, err := s.rents.Pay(r.Context(), callerFrom(r.Context()), id, in)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusOK, d)
}

func (s *Server) handleReversePayment(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	d, err := s.rents.Reverse(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusOK, d)
}

type chargeRequest struct {
	Kind        string `json:"kind"`
	Description string `json:"description"`
	Amount      string `json:"amount"`
	Destination string `json:"destination"`
}

func (s *Server) handleAddCharge(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	var body chargeRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	charge := &domain.Charge{
		Kind: domain.ChargeKind(body.Kind), Description: body.Description,
		Destination: domain.ChargeDestination(body.Destination),
	}
	if m, err := domain.ParseMoney(body.Amount); err == nil {
		charge.Amount = m
	} else {
		v := &domain.ValidationError{}
		v.Add("amount", "must be an amount such as 1500.00")
		writeError(w, s.logger, v)
		return
	}
	d, err := s.rents.AddCharge(r.Context(), callerFrom(r.Context()), id, charge)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusCreated, d)
}

func (s *Server) handleRemoveCharge(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	charge, err := requiredUUID("charge_id", r.PathValue("chargeID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	d, err := s.rents.RemoveCharge(r.Context(), callerFrom(r.Context()), id, charge)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusOK, d)
}

func (s *Server) handleChargeDestination(w http.ResponseWriter, r *http.Request) {
	id, ok := s.rentID(w, r)
	if !ok {
		return
	}
	charge, err := requiredUUID("charge_id", r.PathValue("chargeID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	var body struct {
		Destination string `json:"destination"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	d, err := s.rents.SetChargeDestination(r.Context(), callerFrom(r.Context()), id, charge, domain.ChargeDestination(body.Destination))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeRent(w, s, http.StatusOK, d)
}

// --- dashboard ------------------------------------------------------------------

type deadlineBody struct {
	ContractID string              `json:"contract_id"`
	Registry   string              `json:"registry"`
	Address    propertyAddressBody `json:"address"`
	On         domain.Date         `json:"on"`
}

type dashboardBody struct {
	Today      domain.Date `json:"today"`
	MonthStart domain.Date `json:"month_start"`
	MonthEnd   domain.Date `json:"month_end"`
	Month      struct {
		Expected      domain.Money `json:"expected"`
		ExpectedCount int          `json:"expected_count"`
		Received      domain.Money `json:"received"`
		ReceivedCount int          `json:"received_count"`
		Open          domain.Money `json:"open"`
		OpenCount     int          `json:"open_count"`
		OfficeFee     domain.Money `json:"office_fee"`
		PaidOut       domain.Money `json:"paid_out"`
		PaidOutCount  int          `json:"paid_out_count"`
	} `json:"month"`
	Payouts struct {
		Pending       domain.Money `json:"pending"`
		Beneficiaries int          `json:"beneficiaries"`
	} `json:"payouts"`
	Overdue struct {
		Count  int          `json:"count"`
		Amount domain.Money `json:"amount"`
	} `json:"overdue"`
	Portfolio struct {
		Properties       int          `json:"properties"`
		LeasedProperties int          `json:"leased_properties"`
		ActiveContracts  int          `json:"active_contracts"`
		RentRoll         domain.Money `json:"rent_roll"`
	} `json:"portfolio"`
	Expiring    []deadlineBody `json:"expiring"`
	Adjustments []deadlineBody `json:"adjustments"`
	DueToday    []rentViewBody `json:"due_today"`
	OverdueList []rentViewBody `json:"overdue_rents"`
}

func presentDeadlines(list []usecase.ContractDeadline) []deadlineBody {
	out := make([]deadlineBody, 0, len(list))
	for _, d := range list {
		out = append(out, deadlineBody{ContractID: d.ContractID.String(), Registry: d.Registry, Address: presentPropertyAddress(d.Address), On: d.On})
	}
	return out
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	v, err := s.rents.Dashboard(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	var out dashboardBody
	out.Today, out.MonthStart, out.MonthEnd = v.Today, v.MonthStart, v.MonthEnd
	out.Month.Expected, out.Month.ExpectedCount = v.Month.Expected, v.Month.ExpectedCount
	out.Month.Received, out.Month.ReceivedCount = v.Month.Received, v.Month.ReceivedCount
	out.Month.Open, out.Month.OpenCount, out.Month.OfficeFee = v.Month.Open, v.Month.OpenCount, v.Month.OfficeFee
	out.Month.PaidOut, out.Month.PaidOutCount = v.Month.PaidOut, v.Month.PaidOutCount
	out.Payouts.Pending, out.Payouts.Beneficiaries = v.Payouts.Pending, v.Payouts.Beneficiaries
	out.Overdue.Count, out.Overdue.Amount = v.OverdueCount, v.OverdueAmount
	out.Portfolio.Properties, out.Portfolio.LeasedProperties = v.Portfolio.Properties, v.Portfolio.LeasedProperties
	out.Portfolio.ActiveContracts, out.Portfolio.RentRoll = v.Portfolio.ActiveContracts, v.Portfolio.RentRoll
	out.Expiring, out.Adjustments = presentDeadlines(v.Expiring), presentDeadlines(v.Adjustments)
	out.DueToday = make([]rentViewBody, 0, len(v.DueToday))
	for i := range v.DueToday {
		out.DueToday = append(out.DueToday, presentRentView(&v.DueToday[i], v.Today))
	}
	out.OverdueList = make([]rentViewBody, 0, len(v.Overdue))
	for i := range v.Overdue {
		out.OverdueList = append(out.OverdueList, presentRentView(&v.Overdue[i], v.Today))
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}
