package http

import (
	"net/http"
	"time"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// amendmentRequest is an adjustment as a client sends it. The rate is a
// percentage string, signed; indexed_rent may be left out for the suggestion.
type amendmentRequest struct {
	AmendedOn        string   `json:"amended_on"`
	IndexRate        string   `json:"index_rate"`
	IndexedRent      string   `json:"indexed_rent"`
	Acknowledgements []string `json:"acknowledgments"`
}

func (body amendmentRequest) toInput() (usecase.AmendmentInput, []domain.NoticeCode, error) {
	v := &domain.ValidationError{}
	var in usecase.AmendmentInput
	if on, err := domain.ParseDate(body.AmendedOn); err == nil {
		in.AmendedOn = on
	} else if body.AmendedOn == "" {
		v.Add("amended_on", "is required")
	} else {
		v.Add("amended_on", "must be a date written YYYY-MM-DD")
	}
	if rate, err := domain.ParseRate(body.IndexRate); err == nil {
		in.IndexRate = rate
	} else if body.IndexRate == "" {
		v.Add("index_rate", "is required")
	} else {
		v.Add("index_rate", "must be a percentage with up to four decimal places")
	}
	if body.IndexedRent != "" {
		if m, err := domain.ParseMoney(body.IndexedRent); err == nil {
			in.IndexedRent = &m
		} else {
			v.Add("indexed_rent", "must be an amount such as 1500.00")
		}
	}
	codes := make([]domain.NoticeCode, 0, len(body.Acknowledgements))
	for _, raw := range body.Acknowledgements {
		if domain.NoticeCode(raw) != domain.NoticeAdjustmentPeriod {
			v.Add("acknowledgments", "names an unknown notice")
			continue
		}
		codes = append(codes, domain.NoticeCode(raw))
	}
	return in, codes, v.OrNil()
}

type amendmentBody struct {
	ID                   string                 `json:"id"`
	AmendedOn            domain.Date            `json:"amended_on"`
	AdjustmentIndex      domain.AdjustmentIndex `json:"adjustment_index"`
	IndexRate            domain.Rate            `json:"index_rate"`
	PreviousRent         domain.Money           `json:"previous_rent"`
	IndexedRent          domain.Money           `json:"indexed_rent"`
	PeriodAcknowledgedAt *time.Time             `json:"period_acknowledged_at"`
	CreatedAt            time.Time              `json:"created_at"`
}

func presentAmendments(list []domain.Amendment) []amendmentBody {
	out := make([]amendmentBody, 0, len(list))
	for _, a := range list {
		out = append(out, amendmentBody{
			ID: a.ID.String(), AmendedOn: a.AmendedOn, AdjustmentIndex: a.Index, IndexRate: a.IndexRate,
			PreviousRent: a.PreviousRent, IndexedRent: a.IndexedRent,
			PeriodAcknowledgedAt: a.PeriodAcknowledgedAt, CreatedAt: a.CreatedAt,
		})
	}
	return out
}

type amendmentPreviewBody struct {
	PreviousRent  domain.Money        `json:"previous_rent"`
	SuggestedRent domain.Money        `json:"suggested_rent"`
	IndexedRent   domain.Money        `json:"indexed_rent"`
	FirstSequence int                 `json:"first_sequence"`
	AffectedRents int                 `json:"affected_rents"`
	FirstDueOn    *domain.Date        `json:"first_due_on"`
	Notices       []domain.NoticeCode `json:"notices"`
}

func (s *Server) handlePreviewAmendment(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	var body amendmentRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	in, _, err := body.toInput()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	preview, err := s.contracts.PreviewAmendment(r.Context(), callerFrom(r.Context()), id, in)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := amendmentPreviewBody{
		PreviousRent: preview.Amendment.PreviousRent, SuggestedRent: preview.SuggestedRent,
		IndexedRent: preview.Amendment.IndexedRent, FirstSequence: preview.FirstSequence,
		AffectedRents: preview.AffectedRents, FirstDueOn: preview.FirstDueOn, Notices: preview.Notices,
	}
	if out.Notices == nil {
		out.Notices = []domain.NoticeCode{}
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handleCreateAmendment(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	version := ifMatchVersion(r)
	var body amendmentRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	in, acknowledged, err := body.toInput()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.contracts.Amend(r.Context(), callerFrom(r.Context()), id, version, in, acknowledged)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusCreated, view)
}

func (s *Server) handleDeleteAmendment(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("contract_id", r.PathValue("contractID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	amendment, err := requiredUUID("amendment_id", r.PathValue("amendmentID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.contracts.UndoAmendment(r.Context(), callerFrom(r.Context()), id, amendment, ifMatchVersion(r))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeContract(w, s, http.StatusOK, view)
}
