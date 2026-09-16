package http

import (
	"context"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
	"uuid"

	"imobiliary/internal/platform/metrics"
)

// middleware wraps a handler with behaviour applied around every request.
type middleware func(http.Handler) http.Handler

// chain applies middlewares so that the first listed runs outermost.
func chain(h http.Handler, middlewares ...middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}

// contextKey is unexported so no other package can collide with these keys.
type contextKey int

const requestInfoKey contextKey = iota

// requestInfo is what every log line about a request carries.
type requestInfo struct {
	// ID is generated here for every request and returned in X-Request-ID.
	// An incoming value is not trusted: it would let a client write whatever
	// it liked into the logs and the audit trail.
	ID string
	// TraceID and ParentSpanID come from a valid W3C traceparent header, so a
	// request can be followed from the platform into this service.
	TraceID      string
	ParentSpanID string
	// ClientIP is the address the request is charged and logged to.
	ClientIP string
}

// infoFrom returns the request's info, or an empty one outside a request.
func infoFrom(ctx context.Context) *requestInfo {
	if info, ok := ctx.Value(requestInfoKey).(*requestInfo); ok {
		return info
	}
	return &requestInfo{}
}

// identify attaches the request ID, trace context and client address.
func identify(trustProxy bool) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := &requestInfo{
				ID:       uuid.NewV7().String(),
				ClientIP: rawClientIP(r, trustProxy),
			}
			info.TraceID, info.ParentSpanID, _ = parseTraceparent(r.Header.Get("traceparent"))
			w.Header().Set("X-Request-ID", info.ID)
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestInfoKey, info)))
		})
	}
}

// secureHeaders applies to every API response. Nothing this API returns may
// be cached by an intermediary or sniffed into another content type.
func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// statusRecorder remembers what a handler wrote, for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// recoverPanics turns a panic in a handler into a 500 instead of killing the
// process and dropping every other in-flight request.
func recoverPanics(logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					if recovered == http.ErrAbortHandler {
						panic(recovered)
					}
					logger.Error("handler panicked",
						slog.Any("panic", recovered),
						slog.String("request_id", infoFrom(r.Context()).ID),
					)
					writeFailure(w, logger, http.StatusInternalServerError, codeInternal, "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// observer records one log line and the metrics for each request.
type observer struct {
	logger   *slog.Logger
	requests *metrics.CounterVec
	duration *metrics.HistogramVec
}

func newObserver(logger *slog.Logger, registry *metrics.Registry) *observer {
	return &observer{
		logger: logger,
		requests: registry.Counter("imobiliary_http_requests_total",
			"HTTP requests served, by method, route pattern and status.", "method", "route", "status"),
		duration: registry.Histogram("imobiliary_http_request_duration_seconds",
			"Time to serve an HTTP request, by method and route pattern.",
			metrics.DefaultDurationBuckets, "method", "route"),
	}
}

// observe must wrap the router directly, with no middleware in between that
// replaces the request: the router records the matched pattern on the very
// request value it receives, and that is where this reads it back.
func (o *observer) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}

		next.ServeHTTP(recorder, r)

		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}
		elapsed := time.Since(started)
		route := routeLabel(r)
		method := methodLabel(r.Method)
		o.requests.Inc(method, route, strconv.Itoa(recorder.status))
		o.duration.Observe(elapsed.Seconds(), method, route)

		info := infoFrom(r.Context())
		attrs := []slog.Attr{
			slog.String("request_id", info.ID),
			slog.String("method", r.Method),
			// The pattern, not the path: a path carries identifiers, which do
			// not belong in operational logs.
			slog.String("route", route),
			slog.Int("status", recorder.status),
			slog.Int64("bytes", recorder.bytes),
			// Milliseconds as a float: a Duration attribute logs whole
			// nanoseconds, and on Windows the clock granularity makes every
			// fast handler read as exactly 0.
			slog.Float64("duration_ms", float64(elapsed.Microseconds())/1000),
			slog.String("client_ip", info.ClientIP),
		}
		if info.TraceID != "" {
			attrs = append(attrs, slog.String("trace_id", info.TraceID), slog.String("parent_span_id", info.ParentSpanID))
		}
		o.logger.LogAttrs(r.Context(), slog.LevelInfo, "request", attrs...)
	})
}

// routeLabel is the matched pattern, or "unmatched". Unknown paths are
// collapsed into one label so a scanner probing random URLs cannot create an
// unbounded number of metric series.
func routeLabel(r *http.Request) string {
	if r.Pattern == "" || r.Pattern == "/" {
		return "unmatched"
	}
	return r.Pattern
}

func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

// limitBody caps how much a client may send.
func limitBody(maxBytes int64) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// parseTraceparent reads a W3C trace context header:
// version-traceid-parentid-flags, lowercase hex, with neither identifier all
// zeros. Anything else is ignored rather than logged.
func parseTraceparent(header string) (traceID, parentID string, ok bool) {
	parts := strings.Split(header, "-")
	if len(parts) != 4 || len(parts[0]) != 2 || len(parts[1]) != 32 || len(parts[2]) != 16 || len(parts[3]) != 2 {
		return "", "", false
	}
	if parts[0] == "ff" {
		return "", "", false
	}
	for _, p := range parts {
		if strings.ToLower(p) != p {
			return "", "", false
		}
		if _, err := hex.DecodeString(p); err != nil {
			return "", "", false
		}
	}
	if strings.Trim(parts[1], "0") == "" || strings.Trim(parts[2], "0") == "" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// rawClientIP is the address the request came from.
//
// X-Forwarded-For is honoured only when the deployment declares that a trusted
// proxy sets it. Trusting it unconditionally would let any client pick the
// address it is logged under, which the access records required by the Marco
// Civil must not allow. Copied from docgen-api, with the parsed address
// validated so a forged header cannot inject arbitrary text.
func rawClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			if addr, err := netip.ParseAddr(strings.TrimSpace(first)); err == nil {
				return addr.Unmap().String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
