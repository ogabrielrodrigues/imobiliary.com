package http

import (
	"bytes"
	"context"
	json "encoding/json/v2"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"uuid"

	"imobiliary/internal/platform/logging"
	"imobiliary/internal/platform/metrics"
)

type fixture struct {
	handler  http.Handler
	logs     *bytes.Buffer
	registry *metrics.Registry
	readyErr error
}

func newFixture(t *testing.T, trustProxy bool) *fixture {
	t.Helper()
	f := &fixture{logs: &bytes.Buffer{}, registry: metrics.NewRegistry()}
	server := NewServer(Options{
		Logger:            logging.New(f.logs, 0),
		Metrics:           f.registry,
		Ready:             func(context.Context) error { return f.readyErr },
		TrustProxyHeaders: trustProxy,
		MaxRequestBytes:   1 << 10,
	})
	f.handler = server.Handler()
	return f
}

func (f *fixture) do(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func TestHealthAndReadiness(t *testing.T) {
	f := newFixture(t, false)

	if rec := f.do(httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("/healthz = %d", rec.Code)
	}
	if rec := f.do(httptest.NewRequest(http.MethodGet, "/readyz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("/readyz with a working database = %d", rec.Code)
	}

	f.readyErr = errors.New("dial tcp 127.0.0.1:5432: connection refused")
	rec := f.do(httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/readyz with a failing database = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "5432") {
		t.Fatalf("the readiness body leaks the failure: %s", rec.Body.String())
	}
	// Liveness does not depend on the database.
	if rec := f.do(httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("/healthz with a failing database = %d", rec.Code)
	}
}

func TestEveryResponseCarriesARequestIDAndSafeHeaders(t *testing.T) {
	f := newFixture(t, false)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Request-ID", "attacker-chosen")
	rec := f.do(req)

	id := rec.Header().Get("X-Request-ID")
	if _, err := uuid.Parse(id); err != nil {
		t.Fatalf("X-Request-ID = %q, want a generated UUID", id)
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing security headers: %v", rec.Header())
	}
	if strings.Contains(f.logs.String(), "attacker-chosen") {
		t.Fatal("a client-supplied request ID reached the log")
	}
}

func TestUnknownRoutesAreJSONAndCollapsedInMetrics(t *testing.T) {
	f := newFixture(t, false)
	for _, path := range []string{"/v1/contracts/0191e0c4-1111-7000-8000-000000000001", "/wp-admin", "/.env"} {
		rec := f.do(httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s = %d %s", path, rec.Code, rec.Header().Get("Content-Type"))
		}
	}

	var exposition bytes.Buffer
	if err := f.registry.Expose(&exposition); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(exposition.String(), `imobiliary_http_requests_total{method="GET",route="unmatched",status="404"} 3`) {
		t.Fatalf("unknown routes were not collapsed:\n%s", exposition.String())
	}
	if strings.Contains(exposition.String(), "wp-admin") || strings.Contains(f.logs.String(), "0191e0c4") {
		t.Fatal("a raw path reached the metrics or the log")
	}
}

func TestAccessLogLine(t *testing.T) {
	f := newFixture(t, true)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	f.do(req)

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(f.logs.Bytes()), &line); err != nil {
		t.Fatalf("log is not one JSON line: %v\n%s", err, f.logs.String())
	}
	want := map[string]any{
		"msg": "request", "route": "GET /healthz", "status": float64(200),
		"client_ip": "203.0.113.7", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
	}
	for k, v := range want {
		if line[k] != v {
			t.Errorf("log %s = %v, want %v", k, line[k], v)
		}
	}
}

func TestForwardedForIsIgnoredUnlessTrusted(t *testing.T) {
	for _, c := range []struct {
		trust  bool
		header string
		want   string
	}{
		{false, "203.0.113.7", "192.0.2.1"},
		{true, "203.0.113.7", "203.0.113.7"},
		{true, "not-an-address\n{\"forged\":true}", "192.0.2.1"},
		{true, "::ffff:203.0.113.7", "203.0.113.7"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "192.0.2.1:54321"
		req.Header.Set("X-Forwarded-For", c.header)
		if got := rawClientIP(req, c.trust); got != c.want {
			t.Errorf("trust=%v header=%q: client IP = %q, want %q", c.trust, c.header, got, c.want)
		}
	}
}

func TestParseTraceparent(t *testing.T) {
	if trace, parent, ok := parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"); !ok ||
		trace != "4bf92f3577b34da6a3ce929d0e0e4736" || parent != "00f067aa0ba902b7" {
		t.Fatal("a valid traceparent was rejected")
	}
	for _, bad := range []string{
		"", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
		"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e47zz-00f067aa0ba902b7-01",
	} {
		if _, _, ok := parseTraceparent(bad); ok {
			t.Errorf("parseTraceparent(%q) accepted an invalid header", bad)
		}
	}
}

func TestPanicsBecomeA500(t *testing.T) {
	var logs bytes.Buffer
	logger := logging.New(&logs, 0)
	h := chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }), recoverPanics(logger))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("panic answered %d %s", rec.Code, rec.Body.String())
	}
}
