// Package metrics exposes counters and histograms in the Prometheus text
// format.
//
// The format is a few lines of text, so it is written here rather than
// through the Prometheus client library and its dependency tree. Prometheus,
// Grafana Alloy and the Datadog Agent's OpenMetrics check all scrape it.
//
// Label values must come from a small, known set: a route pattern, never a
// path with an identifier in it, and never anything a user typed.
package metrics

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry holds every metric the service exposes.
type Registry struct {
	mu      sync.Mutex
	metrics []writer
	names   map[string]bool
}

type writer interface {
	name() string
	write(w io.Writer) error
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{names: make(map[string]bool)}
}

func (r *Registry) register(m writer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.names[m.name()] {
		// Registration happens once at start-up, so a duplicate is a wiring
		// mistake to catch immediately, not a condition to handle.
		panic("metrics: " + m.name() + " registered twice")
	}
	r.names[m.name()] = true
	r.metrics = append(r.metrics, m)
}

// Handler serves the registry in the text exposition format.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_ = r.Expose(w)
	})
}

// Expose writes every metric, in registration order.
func (r *Registry) Expose(w io.Writer) error {
	r.mu.Lock()
	metrics := slices.Clone(r.metrics)
	r.mu.Unlock()
	for _, m := range metrics {
		if err := m.write(w); err != nil {
			return err
		}
	}
	return nil
}

// vec is the shared part of a labelled metric: one series per combination of
// label values, created on first use.
type vec[S any] struct {
	metricName string
	help       string
	labels     []string
	newSeries  func() *S

	mu     sync.RWMutex
	series map[string]*S
	values map[string][]string
}

func (v *vec[S]) name() string { return v.metricName }

// get returns the series for the given label values. The read path takes only
// a shared lock, so concurrent requests updating existing series never queue
// behind one another.
func (v *vec[S]) get(values []string) *S {
	if len(values) != len(v.labels) {
		panic(fmt.Sprintf("metrics: %s takes %d label values, got %d", v.metricName, len(v.labels), len(values)))
	}
	key := strings.Join(values, "\xff")

	v.mu.RLock()
	s, ok := v.series[key]
	v.mu.RUnlock()
	if ok {
		return s
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	if s, ok := v.series[key]; ok {
		return s
	}
	s = v.newSeries()
	v.series[key] = s
	v.values[key] = slices.Clone(values)
	return s
}

// sorted returns the series keys in a stable order, so a scrape is
// deterministic and diffable.
func (v *vec[S]) sorted() ([]string, map[string]*S, map[string][]string) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	keys := make([]string, 0, len(v.series))
	series := make(map[string]*S, len(v.series))
	values := make(map[string][]string, len(v.series))
	for k, s := range v.series {
		keys = append(keys, k)
		series[k] = s
		values[k] = v.values[k]
	}
	slices.Sort(keys)
	return keys, series, values
}

func (v *vec[S]) header(w io.Writer, kind string) error {
	_, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", v.metricName, escapeHelp(v.help), v.metricName, kind)
	return err
}

// CounterVec is a monotonically increasing count, per label combination.
type CounterVec struct {
	vec[atomic.Uint64]
}

// Counter registers a counter.
func (r *Registry) Counter(name, help string, labels ...string) *CounterVec {
	c := &CounterVec{vec[atomic.Uint64]{
		metricName: name, help: help, labels: labels,
		newSeries: func() *atomic.Uint64 { return new(atomic.Uint64) },
		series:    make(map[string]*atomic.Uint64), values: make(map[string][]string),
	}}
	r.register(c)
	return c
}

// Inc adds one to the series with the given label values.
func (c *CounterVec) Inc(values ...string) { c.get(values).Add(1) }

func (c *CounterVec) write(w io.Writer) error {
	if err := c.header(w, "counter"); err != nil {
		return err
	}
	keys, series, values := c.sorted()
	for _, k := range keys {
		if _, err := fmt.Fprintf(w, "%s%s %d\n", c.metricName, labelSet(c.labels, values[k], "", ""), series[k].Load()); err != nil {
			return err
		}
	}
	return nil
}

// HistogramVec counts observations into cumulative buckets, per label
// combination.
type HistogramVec struct {
	vec[histogram]
	buckets []float64
}

type histogram struct {
	counts  []atomic.Uint64 // one per bucket, not cumulative
	count   atomic.Uint64
	sumBits atomic.Uint64
}

// DefaultDurationBuckets suit request latencies in seconds.
var DefaultDurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// Histogram registers a histogram with the given upper bounds, which must be
// sorted in increasing order.
func (r *Registry) Histogram(name, help string, buckets []float64, labels ...string) *HistogramVec {
	if !slices.IsSorted(buckets) {
		panic("metrics: " + name + " buckets are not sorted")
	}
	bounds := slices.Clone(buckets)
	h := &HistogramVec{buckets: bounds}
	h.vec = vec[histogram]{
		metricName: name, help: help, labels: labels,
		newSeries: func() *histogram { return &histogram{counts: make([]atomic.Uint64, len(bounds))} },
		series:    make(map[string]*histogram), values: make(map[string][]string),
	}
	r.register(h)
	return h
}

// Observe records one value in the series with the given label values.
func (h *HistogramVec) Observe(value float64, values ...string) {
	s := h.get(values)
	if i, _ := slices.BinarySearch(h.buckets, value); i < len(h.buckets) {
		s.counts[i].Add(1)
	}
	s.count.Add(1)
	for {
		old := s.sumBits.Load()
		next := math.Float64bits(math.Float64frombits(old) + value)
		if s.sumBits.CompareAndSwap(old, next) {
			return
		}
	}
}

func (h *HistogramVec) write(w io.Writer) error {
	if err := h.header(w, "histogram"); err != nil {
		return err
	}
	keys, series, values := h.sorted()
	for _, k := range keys {
		s := series[k]
		var cumulative uint64
		for i, bound := range h.buckets {
			cumulative += s.counts[i].Load()
			le := strconv.FormatFloat(bound, 'g', -1, 64)
			if _, err := fmt.Fprintf(w, "%s_bucket%s %d\n", h.metricName, labelSet(h.labels, values[k], "le", le), cumulative); err != nil {
				return err
			}
		}
		count := s.count.Load()
		if _, err := fmt.Fprintf(w, "%s_bucket%s %d\n%s_sum%s %s\n%s_count%s %d\n",
			h.metricName, labelSet(h.labels, values[k], "le", "+Inf"), count,
			h.metricName, labelSet(h.labels, values[k], "", ""), strconv.FormatFloat(math.Float64frombits(s.sumBits.Load()), 'g', -1, 64),
			h.metricName, labelSet(h.labels, values[k], "", ""), count,
		); err != nil {
			return err
		}
	}
	return nil
}

// labelSet writes {a="1",b="2"}, with an optional extra label appended.
func labelSet(names, values []string, extraName, extraValue string) string {
	if len(names) == 0 && extraName == "" {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, name := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(name)
		b.WriteString(`="`)
		b.WriteString(escapeLabel(values[i]))
		b.WriteByte('"')
	}
	if extraName != "" {
		if len(names) > 0 {
			b.WriteByte(',')
		}
		b.WriteString(extraName)
		b.WriteString(`="`)
		b.WriteString(escapeLabel(extraValue))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

var (
	labelEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`)
	helpEscaper  = strings.NewReplacer(`\`, `\\`, "\n", `\n`)
)

func escapeLabel(s string) string { return labelEscaper.Replace(s) }
func escapeHelp(s string) string  { return helpEscaper.Replace(s) }
