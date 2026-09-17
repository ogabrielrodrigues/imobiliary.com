package http

import (
	"encoding/base64"
	json "encoding/json/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- shapes -----------------------------------------------------------------

type contractPartyBody struct {
	PersonID string            `json:"person_id"`
	Role     domain.PartyRole  `json:"role"`
	Name     string            `json:"name,omitzero"`
	Kind     domain.PersonKind `json:"kind,omitzero"`
}

type instalmentBody struct {
	Sequence int          `json:"sequence"`
	DueOn    domain.Date  `json:"due_on"`
	Amount   domain.Money `json:"amount"`
}

type rentBody struct {
	ID           string        `json:"id"`
	Sequence     int           `json:"sequence"`
	DueOn        domain.Date   `json:"due_on"`
	Amount       domain.Money  `json:"amount"`
	ChargesTotal domain.Money  `json:"charges_total"`
	LateFee      domain.Money  `json:"late_fee"`
	AmountPaid   *domain.Money `json:"amount_paid"`
	PaidOn       *domain.Date  `json:"paid_on"`
	// Status is computed on the office's calendar, never stored.
	Status string `json:"status"`
}

type acknowledgementBody struct {
	Code           domain.NoticeCode `json:"code"`
	AcknowledgedAt time.Time         `json:"acknowledged_at"`
}

// contractTermsBody is what every contract shape shares.
type contractTermsBody struct {
	PropertyID       string                 `json:"property_id"`
	Registry         string                 `json:"registry"`
	GuaranteeKind    domain.GuaranteeKind   `json:"guarantee_kind"`
	AdvanceRent      bool                   `json:"advance_rent"`
	DepositAmount    domain.Money           `json:"deposit_amount"`
	Rent             domain.Money           `json:"rent"`
	CurrentRent      domain.Money           `json:"current_rent"`
	AdminFee         domain.Rate            `json:"admin_fee"`
	LatePenaltyRate  domain.Rate            `json:"late_penalty_rate"`
	LateInterestRate domain.Rate            `json:"late_interest_rate"`
	DueDay           int                    `json:"due_day"`
	AdjustmentIndex  domain.AdjustmentIndex `json:"adjustment_index"`
	SignedOn         domain.Date            `json:"signed_on"`
	StartsOn         domain.Date            `json:"starts_on"`
	ExpiresOn        domain.Date            `json:"expires_on"`
	TerminatedOn     *domain.Date           `json:"terminated_on"`
	Status           domain.ContractStatus  `json:"status"`
}

func presentTerms(c *domain.Contract, today domain.Date) contractTermsBody {
	return contractTermsBody{
		PropertyID: c.PropertyID.String(), Registry: c.Registry, GuaranteeKind: c.GuaranteeKind, AdvanceRent: c.AdvanceRent,
		DepositAmount: c.DepositAmount, Rent: c.Rent, CurrentRent: c.CurrentRent, AdminFee: c.AdminFee,
		LatePenaltyRate: c.LatePenaltyRate, LateInterestRate: c.LateInterestRate, DueDay: c.DueDay,
		AdjustmentIndex: c.AdjustmentIndex, SignedOn: c.SignedOn, StartsOn: c.StartsOn,
		ExpiresOn: c.ExpiresOn, TerminatedOn: c.TerminatedOn, Status: c.StatusOn(today),
	}
}

type contractBody struct {
	ID string `json:"id"`
	contractTermsBody
	Property         propertyRefBody       `json:"property"`
	Parties          []contractPartyBody   `json:"parties"`
	Acknowledgements []acknowledgementBody `json:"acknowledgments"`
	Rents            []rentBody            `json:"rents"`
	Amendments       []amendmentBody       `json:"amendments"`
	Version          int                   `json:"version"`
	CreatedAt        time.Time             `json:"created_at"`
	UpdatedAt        time.Time             `json:"updated_at"`
}

type propertyRefBody struct {
	ID      string              `json:"id"`
	Address propertyAddressBody `json:"address"`
}

func rentStatus(r usecase.RentRecord, today domain.Date) string {
	switch {
	case r.PaidOn != nil:
		return "paid"
	case r.DueOn.Before(today):
		return "overdue"
	default:
		return "pending"
	}
}

func presentContract(v *usecase.ContractView) contractBody {
	c := v.Contract
	out := contractBody{
		ID:                c.ID.String(),
		contractTermsBody: presentTerms(c, v.Today),
		Property:          propertyRefBody{ID: v.Property.ID.String(), Address: presentPropertyAddress(v.Property.Address)},
		Parties:           make([]contractPartyBody, 0, len(v.Parties)),
		Acknowledgements:  make([]acknowledgementBody, 0, len(c.Acknowledgements)),
		Rents:             make([]rentBody, 0, len(v.Rents)),
		Amendments:        presentAmendments(v.Amendments),
		Version:           c.Version, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
	}
	for _, p := range v.Parties {
		out.Parties = append(out.Parties, contractPartyBody{PersonID: p.PersonID.String(), Role: p.Role, Name: p.Name, Kind: p.Kind})
	}
	for _, a := range c.Acknowledgements {
		out.Acknowledgements = append(out.Acknowledgements, acknowledgementBody{Code: a.Code, AcknowledgedAt: a.AcknowledgedAt})
	}
	for _, r := range v.Rents {
		out.Rents = append(out.Rents, rentBody{
			ID: r.ID.String(), Sequence: r.Sequence, DueOn: r.DueOn, Amount: r.Amount, ChargesTotal: r.ChargesTotal, LateFee: r.LateFee,
			AmountPaid: r.AmountPaid, PaidOn: r.PaidOn, Status: rentStatus(r, v.Today),
		})
	}
	return out
}

// contractRequest is what a client sends to preview, create or replace a
// contract. Money and rates are strings, parsed here so a malformed one is an
// error on its own field.
type contractRequest struct {
	PropertyID       string              `json:"property_id"`
	Registry         string              `json:"registry"`
	GuaranteeKind    string              `json:"guarantee_kind"`
	AdvanceRent      *bool               `json:"advance_rent"`
	DepositAmount    string              `json:"deposit_amount"`
	Rent             string              `json:"rent"`
	AdminFee         string              `json:"admin_fee"`
	LatePenaltyRate  string              `json:"late_penalty_rate"`
	LateInterestRate string              `json:"late_interest_rate"`
	DueDay           int                 `json:"due_day"`
	AdjustmentIndex  string              `json:"adjustment_index"`
	SignedOn         string              `json:"signed_on"`
	StartsOn         string              `json:"starts_on"`
	ExpiresOn        string              `json:"expires_on"`
	Parties          []contractPartyBody `json:"parties"`
	Acknowledgements []string            `json:"acknowledgments"`
}

func (body contractRequest) toContract() (*domain.Contract, []domain.NoticeCode, error) {
	v := &domain.ValidationError{}
	c := &domain.Contract{
		Registry:        body.Registry,
		GuaranteeKind:   domain.GuaranteeKind(body.GuaranteeKind),
		DueDay:          body.DueDay,
		AdjustmentIndex: domain.AdjustmentIndex(body.AdjustmentIndex),
		AdminFee:        domain.DefaultAdminFee,
		LatePenaltyRate: domain.DefaultLatePenalty, LateInterestRate: domain.DefaultLateInterest,
	}
	// A choice the office makes, so it has no default.
	if body.AdvanceRent == nil {
		v.Add("advance_rent", "is required")
	} else {
		c.AdvanceRent = *body.AdvanceRent
	}
	if body.PropertyID != "" {
		if id, err := uuid.Parse(body.PropertyID); err == nil {
			c.PropertyID = id
		} else {
			v.Add("property_id", "is not a valid identifier")
		}
	}
	money := func(field, raw string, dst *domain.Money) {
		if raw == "" {
			return
		}
		m, err := domain.ParseMoney(raw)
		if err != nil {
			v.Add(field, "must be an amount such as 1500.00")
			return
		}
		*dst = m
	}
	rate := func(field, raw string, dst *domain.Rate) {
		if raw == "" {
			return
		}
		r, err := domain.ParseRate(raw)
		if err != nil {
			v.Add(field, "must be a percentage with up to four decimal places")
			return
		}
		*dst = r
	}
	date := func(field, raw string, dst *domain.Date) {
		if raw == "" {
			return
		}
		d, err := domain.ParseDate(raw)
		if err != nil {
			v.Add(field, "must be a date written YYYY-MM-DD")
			return
		}
		*dst = d
	}
	money("deposit_amount", body.DepositAmount, &c.DepositAmount)
	money("rent", body.Rent, &c.Rent)
	rate("admin_fee", body.AdminFee, &c.AdminFee)
	rate("late_penalty_rate", body.LatePenaltyRate, &c.LatePenaltyRate)
	rate("late_interest_rate", body.LateInterestRate, &c.LateInterestRate)
	date("signed_on", body.SignedOn, &c.SignedOn)
	date("starts_on", body.StartsOn, &c.StartsOn)
	date("expires_on", body.ExpiresOn, &c.ExpiresOn)

	for i, p := range body.Parties {
		id, err := uuid.Parse(p.PersonID)
		if err != nil {
			v.Add("parties["+strconv.Itoa(i)+"].person_id", "is not a valid identifier")
			continue
		}
		c.Parties = append(c.Parties, domain.ContractParty{PersonID: id, Role: p.Role})
	}
	acknowledged := make([]domain.NoticeCode, 0, len(body.Acknowledgements))
	for _, code := range body.Acknowledgements {
		if !domain.IsNotice(domain.NoticeCode(code)) {
			v.Add("acknowledgments", "names an unknown notice")
			continue
		}
		acknowledged = append(acknowledged, domain.NoticeCode(code))
	}
	return c, acknowledged, v.OrNil()
}

type contractPreviewBody struct {
	Parties  []contractPartyBody `json:"parties"`
	Schedule []instalmentBody    `json:"schedule"`
	Notices  []domain.NoticeCode `json:"notices"`
	Total    domain.Money        `json:"total"`
}

type contractSummaryBody struct {
	ID string `json:"id"`
	contractTermsBody
	Address     propertyAddressBody `json:"address"`
	TenantNames []string            `json:"tenant_names"`
}

type contractsPageBody struct {
	Contracts  []contractSummaryBody `json:"contracts"`
	NextCursor string                `json:"next_cursor,omitzero"`
}

// --- handlers ---------------------------------------------------------------

func (s *Server) handleListContracts(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	q := usecase.ContractQuery{Search: strings.TrimSpace(query.Get("q")), Status: domain.ContractStatus(query.Get("status"))}
	for _, f := range []struct {
		name string
		dst  **uuid.UUID
	}{{"property_id", &q.PropertyID}, {"person_id", &q.PersonID}} {
		if raw := query.Get(f.name); raw != "" {
			id, err := requiredUUID(f.name, raw)
			if err != nil {
				writeError(w, s.logger, err)
				return
			}
			*f.dst = &id
		}
	}
	if raw := query.Get("cursor"); raw != "" {
		cursor, err := decodeCursor(raw)
		if err != nil {
			writeError(w, s.logger, err)
			return
		}
		starts, err := domain.ParseDate(cursor.SortKey)
		if err != nil {
			v := &domain.ValidationError{}
			v.Add("cursor", "is not a cursor this API issued")
			writeError(w, s.logger, v)
			return
		}
		q.After = &usecase.ContractCursor{StartsOn: starts, ID: cursor.ID}
	}
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			v := &domain.ValidationError{}
			v.Add("limit", "must be a positive integer")
			writeError(w, s.logger, v)
			return
		}
		q.Limit = n
	}

	page, err := s.contracts.List(r.Context(), callerFrom(r.Context()), q)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := contractsPageBody{Contracts: make([]contractSummaryBody, 0, len(page.Contracts))}
	for _, row := range page.Contracts {
		names := row.TenantNames
		if names == nil {
			names = []string{}
		}
		out.Contracts = append(out.Contracts, contractSummaryBody{
			ID: row.Contract.ID.String(), contractTermsBody: presentTerms(&row.Contract, page.Today),
			Address: presentPropertyAddress(row.Address), TenantNames: names,
		})
	}
	if page.Next != nil {
		raw, _ := json.Marshal(cursorBody{Key: page.Next.StartsOn.String(), ID: page.Next.ID.String()})
		out.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handlePreviewContract(w http.ResponseWriter, r *http.Request) {
	var body contractRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	contract, _, err := body.toContract()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	preview, err := s.contracts.Preview(r.Context(), callerFrom(r.Context()), contract)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := contractPreviewBody{
		Parties:  make([]contractPartyBody, 0, len(preview.Contract.Parties)),
		Schedule: make([]instalmentBody, 0, len(preview.Schedule)),
		Notices:  preview.Notices,
	}
	if out.Notices == nil {
		out.Notices = []domain.NoticeCode{}
	}
	for _, p := range preview.Contract.Parties {
		out.Parties = append(out.Parties, contractPartyBody{PersonID: p.PersonID.String(), Role: p.Role})
	}
	for _, inst := range preview.Schedule {
		out.Schedule = append(out.Schedule, instalmentBody{Sequence: inst.Sequence, DueOn: inst.DueOn, Amount: inst.Amount})
		if total, err := out.Total.Add(inst.Amount); err == nil {
			out.Total = total
		}
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handleCreateContract(w http.ResponseWriter, r *http.Request) {
	var body contractRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	contract, acknowledged, err := body.toContract()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.contracts.Create(r.Context(), callerFrom(r.Context()), contract, acknowledged)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusCreated, view)
}

func (s *Server) handleGetContract(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.contracts.Get(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusOK, view)
}

func (s *Server) handleUpdateContract(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	version := ifMatchVersion(r)
	var body contractRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	contract, acknowledged, err := body.toContract()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	contract.ID = id
	view, err := s.contracts.Update(r.Context(), callerFrom(r.Context()), contract, version, acknowledged)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusOK, view)
}

type terminationRequest struct {
	TerminatedOn string `json:"terminated_on"`
}

func (s *Server) handleTerminateContract(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	version := ifMatchVersion(r)
	var body terminationRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	on, err := domain.ParseDate(body.TerminatedOn)
	if err != nil {
		v := &domain.ValidationError{}
		v.Add("terminated_on", "must be a date written YYYY-MM-DD")
		writeError(w, s.logger, v)
		return
	}
	view, err := s.contracts.Terminate(r.Context(), callerFrom(r.Context()), id, on, version)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusOK, view)
}

func (s *Server) handleDeleteContract(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.contracts.Delete(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeContract(w http.ResponseWriter, s *Server, status int, view *usecase.ContractView) {
	w.Header().Set("ETag", strconv.Quote(strconv.Itoa(view.Contract.Version)))
	writeJSON(w, s.logger, status, presentContract(view))
}
