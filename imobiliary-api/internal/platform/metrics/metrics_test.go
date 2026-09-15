package metrics

import (
	"strings"
	"sync"
	"testing"
)

func TestExposition(t *testing.T) {
	r := NewRegistry()
	requests := r.Counter("http_requests_total", "Requests served.", "method", "status")
	latency := r.Histogram("http_request_duration_seconds", "Request latency.", []float64{0.1, 1}, "method")

	requests.Inc("GET", "200")
	requests.Inc("GET", "200")
	requests.Inc("POST", `4"0\4`)
	latency.Observe(0.05, "GET")
	latency.Observe(0.1, "GET")
	latency.Observe(3, "GET")

	var b strings.Builder
	if err := r.Expose(&b); err != nil {
		t.Fatal(err)
	}
	want := `# HELP http_requests_total Requests served.
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 2
http_requests_total{method="POST",status="4\"0\\4"} 1
# HELP http_request_duration_seconds Request latency.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",le="0.1"} 2
http_request_duration_seconds_bucket{method="GET",le="1"} 2
http_request_duration_seconds_bucket{method="GET",le="+Inf"} 3
http_request_duration_seconds_sum{method="GET"} 3.15
http_request_duration_seconds_count{method="GET"} 3
`
	if b.String() != want {
		t.Errorf("exposition:\n%s\nwant:\n%s", b.String(), want)
	}
}

func TestConcurrentUpdatesAreNotLost(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("hits_total", "Hits.", "route")
	h := r.Histogram("work_seconds", "Work.", []float64{1}, "route")

	const goroutines, each = 16, 1000
	var wg sync.WaitGroup
	for range goroutines {
		wg.Go(func() {
			for range each {
				c.Inc("/v1/x")
				h.Observe(1, "/v1/x")
			}
		})
	}
	wg.Wait()

	var b strings.Builder
	if err := r.Expose(&b); err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		`hits_total{route="/v1/x"} 16000`,
		`work_seconds_sum{route="/v1/x"} 16000`,
		`work_seconds_count{route="/v1/x"} 16000`,
	} {
		if !strings.Contains(b.String(), line) {
			t.Errorf("missing %q in:\n%s", line, b.String())
		}
	}
}

func TestDuplicateRegistrationPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registering a name twice did not panic")
		}
	}()
	r := NewRegistry()
	r.Counter("x_total", "X.")
	r.Counter("x_total", "X.")
}
