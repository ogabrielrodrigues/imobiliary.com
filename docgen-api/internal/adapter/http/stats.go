package http

import (
	"net/http"
	"strconv"
	"time"
	_ "time/tzdata" // callers name zones like America/Sao_Paulo; Windows ships no zone database

	"docgen/internal/domain"
	"docgen/internal/usecase"
)

// statsResponse is the body of GET /v1/me/stats.
type statsResponse struct {
	Days                    int                     `json:"days"`
	TimeZone                string                  `json:"time_zone"`
	Templates               int                     `json:"templates"`
	Documents               int                     `json:"documents"`
	DocumentsInPeriod       int                     `json:"documents_in_period"`
	DocumentsPreviousPeriod int                     `json:"documents_previous_period"`
	PerDay                  []dayCountResponse      `json:"per_day"`
	TopTemplates            []templateUsageResponse `json:"top_templates"`
}

type dayCountResponse struct {
	// Date is a calendar day in the report's time zone, not an instant.
	Date      string `json:"date"`
	Documents int    `json:"documents"`
}

type templateUsageResponse struct {
	TemplateID string `json:"template_id"`
	Name       string `json:"name"`
	Deleted    bool   `json:"deleted"`
	Documents  int    `json:"documents"`
}

func newStatsResponse(r *usecase.StatsReport) statsResponse {
	out := statsResponse{
		Days:                    r.Days,
		TimeZone:                r.Location.String(),
		Templates:               r.Templates,
		Documents:               r.Documents,
		DocumentsInPeriod:       r.DocumentsInPeriod,
		DocumentsPreviousPeriod: r.DocumentsPreviousPeriod,
		PerDay:                  make([]dayCountResponse, 0, len(r.PerDay)),
		TopTemplates:            make([]templateUsageResponse, 0, len(r.TopTemplates)),
	}
	for _, d := range r.PerDay {
		out.PerDay = append(out.PerDay, dayCountResponse{
			Date:      d.Date.Format("2006-01-02"),
			Documents: d.Documents,
		})
	}
	for _, u := range r.TopTemplates {
		out.TopTemplates = append(out.TopTemplates, templateUsageResponse{
			TemplateID: u.TemplateID.String(),
			Name:       u.Name,
			Deleted:    u.Deleted,
			Documents:  u.Documents,
		})
	}
	return out
}

// handleStats reports the figures behind the account's dashboard.
//
// days picks the window (7, 30 or 90; 30 when omitted) and tz the IANA zone
// that decides where each day starts (UTC when omitted). "Local" is refused:
// it would mean the server's zone, which says nothing about the caller.
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	v := &domain.ValidationError{}

	days := usecase.DefaultStatsPeriod
	if raw := query.Get("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			v.Add("days", "must be 7, 30 or 90")
		}
		days = parsed
	}

	loc := time.UTC
	if name := query.Get("tz"); name != "" {
		zone, err := time.LoadLocation(name)
		if err != nil || name == "Local" {
			v.Add("tz", "must be an IANA time zone, such as America/Sao_Paulo")
		} else {
			loc = zone
		}
	}

	if len(v.Fields) > 0 {
		writeError(w, s.logger, v)
		return
	}

	report, err := s.stats.Report(r.Context(), usecase.StatsRequest{
		OwnerID:  userFrom(r.Context()).ID,
		Days:     days,
		Location: loc,
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newStatsResponse(report))
}
