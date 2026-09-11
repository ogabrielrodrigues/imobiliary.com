//go:build integration

package http_test

import (
	"net/http"
	"testing"
)

type statsBody struct {
	Days                    int    `json:"days"`
	TimeZone                string `json:"time_zone"`
	Templates               int    `json:"templates"`
	Documents               int    `json:"documents"`
	DocumentsInPeriod       int    `json:"documents_in_period"`
	DocumentsPreviousPeriod int    `json:"documents_previous_period"`
	PerDay                  []struct {
		Date      string `json:"date"`
		Documents int    `json:"documents"`
	} `json:"per_day"`
	TopTemplates []struct {
		TemplateID string `json:"template_id"`
		Name       string `json:"name"`
		Deleted    bool   `json:"deleted"`
		Documents  int    `json:"documents"`
	} `json:"top_templates"`
}

// generate uploads nothing: it renders one document from an existing template.
func (s *testServer) generate(templateID, accessToken string) {
	s.t.Helper()
	var document documentBody
	decode(s.t, s.postJSON("/v1/documents", accessToken, map[string]any{
		"template_id": templateID,
		"data":        map[string]string{"name": "Ana"},
	}), http.StatusCreated, &document)
}

func TestStatsOfAnEmptyAccount(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("empty-stats@example.com")

	var stats statsBody
	decode(t, server.get("/v1/me/stats", session.AccessToken), http.StatusOK, &stats)

	if stats.Days != 30 || stats.TimeZone != "UTC" {
		t.Errorf("defaults: %d days in %q, want 30 in UTC", stats.Days, stats.TimeZone)
	}
	if stats.Templates != 0 || stats.Documents != 0 || stats.DocumentsInPeriod != 0 {
		t.Errorf("an empty account reports %+v", stats)
	}
	if len(stats.PerDay) != 30 {
		t.Errorf("per_day has %d entries, want one per day of the window", len(stats.PerDay))
	}
	if len(stats.TopTemplates) != 0 {
		t.Errorf("top_templates = %+v, want none", stats.TopTemplates)
	}
}

func TestStatsCountAndRankWhatWasGenerated(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("stats@example.com")

	var lease, receipt templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Locação",
		buildDOCX(t, "Locatário: {{.name}}")), http.StatusCreated, &lease)
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Recibo",
		buildDOCX(t, "Recebi de {{.name}}")), http.StatusCreated, &receipt)

	server.generate(lease.ID, session.AccessToken)
	server.generate(lease.ID, session.AccessToken)
	server.generate(receipt.ID, session.AccessToken)

	var stats statsBody
	decode(t, server.get("/v1/me/stats?days=7&tz=America/Sao_Paulo", session.AccessToken),
		http.StatusOK, &stats)

	if stats.Days != 7 || stats.TimeZone != "America/Sao_Paulo" {
		t.Errorf("window %d days in %q, want 7 in America/Sao_Paulo", stats.Days, stats.TimeZone)
	}
	if stats.Templates != 2 || stats.Documents != 3 || stats.DocumentsInPeriod != 3 {
		t.Errorf("templates %d, documents %d, in period %d; want 2, 3, 3",
			stats.Templates, stats.Documents, stats.DocumentsInPeriod)
	}
	perDay := 0
	for _, d := range stats.PerDay {
		perDay += d.Documents
	}
	if perDay != 3 {
		t.Errorf("per_day adds up to %d, want 3", perDay)
	}
	if len(stats.TopTemplates) != 2 ||
		stats.TopTemplates[0].TemplateID != lease.ID || stats.TopTemplates[0].Documents != 2 ||
		stats.TopTemplates[1].TemplateID != receipt.ID || stats.TopTemplates[1].Documents != 1 {
		t.Errorf("top_templates = %+v, want Locação (2) then Recibo (1)", stats.TopTemplates)
	}

	// A deleted template keeps its documents, so it still ranks, marked.
	expectStatus(t, server.delete("/v1/templates/"+receipt.ID, session.AccessToken), http.StatusNoContent)
	decode(t, server.get("/v1/me/stats?days=7", session.AccessToken), http.StatusOK, &stats)
	if stats.Templates != 1 || len(stats.TopTemplates) != 2 || !stats.TopTemplates[1].Deleted {
		t.Errorf("after deleting Recibo: templates %d, top %+v", stats.Templates, stats.TopTemplates)
	}
}

func TestStatsAreIsolatedPerAccount(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	owner := server.registerAndLogin("owner-stats@example.com")
	stranger := server.registerAndLogin("stranger-stats@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", owner.AccessToken, "Contrato",
		buildDOCX(t, "Parte: {{.name}}")), http.StatusCreated, &created)
	server.generate(created.ID, owner.AccessToken)

	var stats statsBody
	decode(t, server.get("/v1/me/stats", stranger.AccessToken), http.StatusOK, &stats)
	if stats.Templates != 0 || stats.Documents != 0 || len(stats.TopTemplates) != 0 {
		t.Errorf("another account's figures leaked: %+v", stats)
	}
}

func TestStatsRejectBadRequests(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("bad-stats@example.com")

	expectStatus(t, server.get("/v1/me/stats", ""), http.StatusUnauthorized)

	for _, query := range []string{
		"days=15",
		"days=thirty",
		"tz=Nowhere/Special",
		"tz=Local",
	} {
		resp := server.get("/v1/me/stats?"+query, session.AccessToken)
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("?%s answered %d, want 422", query, resp.StatusCode)
		}
		resp.Body.Close()
	}
}
