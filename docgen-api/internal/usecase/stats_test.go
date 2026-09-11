package usecase

import (
	"context"
	"errors"
	"testing"
	"time"
	_ "time/tzdata" // the test loads a named zone, which Windows does not ship
	"uuid"

	"docgen/internal/domain"
)

// fakeStats answers like the real repository, filtering by the instant it is
// given, and records what it was asked.
type fakeStats struct {
	templates, documents int
	times                []time.Time
	top                  []domain.TemplateUsage

	askedTimesSince time.Time
	askedTopSince   time.Time
}

func (f *fakeStats) CountActiveTemplates(context.Context, uuid.UUID) (int, error) {
	return f.templates, nil
}

func (f *fakeStats) CountDocuments(context.Context, uuid.UUID) (int, error) {
	return f.documents, nil
}

func (f *fakeStats) DocumentTimesSince(_ context.Context, _ uuid.UUID, since time.Time) ([]time.Time, error) {
	f.askedTimesSince = since
	var out []time.Time
	for _, at := range f.times {
		if !at.Before(since) {
			out = append(out, at)
		}
	}
	return out, nil
}

func (f *fakeStats) TopTemplatesSince(_ context.Context, _ uuid.UUID, since time.Time, _ int) ([]domain.TemplateUsage, error) {
	f.askedTopSince = since
	return f.top, nil
}

func saoPaulo(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	return loc
}

func TestStatsCountsADocumentOnTheCallersDay(t *testing.T) {
	loc := saoPaulo(t)
	// Noon on 11 September in São Paulo.
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, loc)
	// 01:30 UTC on the 11th is 22:30 on the 10th in São Paulo.
	lateEvening := time.Date(2026, 9, 11, 1, 30, 0, 0, time.UTC)

	repo := &fakeStats{times: []time.Time{lateEvening}}
	stats := NewStats(StatsConfig{Repo: repo, Now: func() time.Time { return now }})

	report, err := stats.Report(t.Context(), StatsRequest{Days: 7, Location: loc})
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	last := report.PerDay[len(report.PerDay)-1]
	beforeLast := report.PerDay[len(report.PerDay)-2]
	if got := last.Date.Format(dayLayout); got != "2026-09-11" {
		t.Fatalf("the window ends on %s, want 2026-09-11", got)
	}
	if beforeLast.Documents != 1 || last.Documents != 0 {
		t.Errorf("10th = %d, 11th = %d; the document was generated on the evening of the 10th",
			beforeLast.Documents, last.Documents)
	}
}

func TestStatsSplitsThePeriodFromTheOneBefore(t *testing.T) {
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	day := func(offset int) time.Time { return now.AddDate(0, 0, offset) }

	repo := &fakeStats{
		templates: 3,
		documents: 10,
		times: []time.Time{
			day(0), day(-6), // inside the 7-day window
			day(-7), day(-13), // the 7 days before it
			day(-14), // older than both; the repository is not asked for it
		},
	}
	stats := NewStats(StatsConfig{Repo: repo, Now: func() time.Time { return now }})

	report, err := stats.Report(t.Context(), StatsRequest{Days: 7})
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	if report.DocumentsInPeriod != 2 || report.DocumentsPreviousPeriod != 2 {
		t.Errorf("in period %d, previous %d; want 2 and 2",
			report.DocumentsInPeriod, report.DocumentsPreviousPeriod)
	}
	if report.Templates != 3 || report.Documents != 10 {
		t.Errorf("totals %d templates, %d documents; want 3 and 10", report.Templates, report.Documents)
	}

	wantPeriodStart := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	if !repo.askedTopSince.Equal(wantPeriodStart) {
		t.Errorf("ranked templates since %v, want the start of the window %v", repo.askedTopSince, wantPeriodStart)
	}
	if want := wantPeriodStart.AddDate(0, 0, -7); !repo.askedTimesSince.Equal(want) {
		t.Errorf("read documents since %v, want the start of the previous window %v", repo.askedTimesSince, want)
	}
}

func TestStatsFillsEveryDayOfTheWindow(t *testing.T) {
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	stats := NewStats(StatsConfig{Repo: &fakeStats{}, Now: func() time.Time { return now }})

	for _, days := range StatsPeriods {
		report, err := stats.Report(t.Context(), StatsRequest{Days: days})
		if err != nil {
			t.Fatalf("report for %d days: %v", days, err)
		}
		if len(report.PerDay) != days {
			t.Errorf("%d days produced %d entries", days, len(report.PerDay))
		}
		for i := 1; i < len(report.PerDay); i++ {
			gap := report.PerDay[i].Date.Sub(report.PerDay[i-1].Date)
			if gap != 24*time.Hour {
				t.Fatalf("%d days: entries %d and %d are %v apart", days, i-1, i, gap)
			}
		}
	}
}

func TestStatsRejectsAWindowItDoesNotOffer(t *testing.T) {
	stats := NewStats(StatsConfig{Repo: &fakeStats{}})

	_, err := stats.Report(t.Context(), StatsRequest{Days: 15})

	var v *domain.ValidationError
	if !errors.As(err, &v) || len(v.Fields) != 1 || v.Fields[0].Field != "days" {
		t.Fatalf("err = %v, want a validation error on days", err)
	}
}
