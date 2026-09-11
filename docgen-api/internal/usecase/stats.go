package usecase

import (
	"context"
	"slices"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// StatsPeriods are the windows a report may cover, in days. A fixed set rather
// than any number: each is a view the interface offers, and an arbitrary window
// would only invite requests that read a year of rows at a time.
var StatsPeriods = []int{7, 30, 90}

// DefaultStatsPeriod is the window used when a caller names none.
const DefaultStatsPeriod = 30

// topTemplatesLimit is how many templates a report ranks.
const topTemplatesLimit = 5

// dayLayout names a calendar day.
const dayLayout = "2006-01-02"

// Stats builds the figures behind an account's dashboard.
type Stats struct {
	repo StatsRepository
	now  Clock
}

// StatsConfig collects the dependencies of the Stats use case.
type StatsConfig struct {
	Repo StatsRepository
	Now  Clock
}

// NewStats wires the Stats use case.
func NewStats(cfg StatsConfig) *Stats {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Stats{repo: cfg.Repo, now: cfg.Now}
}

// StatsRequest asks for one report.
type StatsRequest struct {
	OwnerID uuid.UUID
	// Days is the length of the window; one of StatsPeriods.
	Days int
	// Location decides where a day starts and ends. Nil means UTC.
	Location *time.Location
}

// DayCount is the number of documents generated on one calendar day, in the
// report's time zone.
type DayCount struct {
	Date      time.Time
	Documents int
}

// StatsReport is everything a dashboard shows about an account.
type StatsReport struct {
	Days     int
	Location *time.Location

	// Templates counts the templates still in use; deleted ones are left out.
	Templates int
	// Documents counts every document the account holds.
	Documents int

	// DocumentsInPeriod covers the window, today included.
	DocumentsInPeriod int
	// DocumentsPreviousPeriod covers the window of the same length just before
	// it, which is what a change is measured against.
	DocumentsPreviousPeriod int

	// PerDay has one entry per day of the window, oldest first, zero-filled so
	// a chart never has to guess at gaps.
	PerDay []DayCount

	// TopTemplates ranks the templates used in the window, most first.
	TopTemplates []domain.TemplateUsage
}

// Report builds the figures for one account.
//
// The window ends today, in the caller's time zone, and starts Days-1 days
// before. Days are counted in that zone because that is the day a person
// remembers: a contract signed at ten at night in São Paulo belongs to that
// evening, not to the UTC date it was stored under.
func (s *Stats) Report(ctx context.Context, req StatsRequest) (*StatsReport, error) {
	if !slices.Contains(StatsPeriods, req.Days) {
		v := &domain.ValidationError{}
		v.Add("days", "must be 7, 30 or 90")
		return nil, v
	}
	loc := req.Location
	if loc == nil {
		loc = time.UTC
	}

	now := s.now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	// AddDate rather than a multiple of 24 hours: a day with a daylight saving
	// change is 23 or 25 hours long, and midnight must still land on midnight.
	periodStart := today.AddDate(0, 0, -(req.Days - 1))
	previousStart := periodStart.AddDate(0, 0, -req.Days)

	templates, err := s.repo.CountActiveTemplates(ctx, req.OwnerID)
	if err != nil {
		return nil, err
	}
	documents, err := s.repo.CountDocuments(ctx, req.OwnerID)
	if err != nil {
		return nil, err
	}
	times, err := s.repo.DocumentTimesSince(ctx, req.OwnerID, previousStart)
	if err != nil {
		return nil, err
	}
	top, err := s.repo.TopTemplatesSince(ctx, req.OwnerID, periodStart, topTemplatesLimit)
	if err != nil {
		return nil, err
	}

	report := &StatsReport{
		Days:         req.Days,
		Location:     loc,
		Templates:    templates,
		Documents:    documents,
		PerDay:       make([]DayCount, req.Days),
		TopTemplates: top,
	}
	index := make(map[string]int, req.Days)
	for i := range report.PerDay {
		day := periodStart.AddDate(0, 0, i)
		report.PerDay[i].Date = day
		index[day.Format(dayLayout)] = i
	}

	for _, at := range times {
		local := at.In(loc)
		if local.Before(periodStart) {
			report.DocumentsPreviousPeriod++
			continue
		}
		if i, ok := index[local.Format(dayLayout)]; ok {
			report.PerDay[i].Documents++
			report.DocumentsInPeriod++
		}
	}
	return report, nil
}
