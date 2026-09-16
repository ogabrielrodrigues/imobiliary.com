package http

import (
	"context"
	"encoding/hex"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
	"uuid"

	"imobiliary/internal/platform/metrics"
	"imobiliary/internal/platform/ratelimit"
	"imobiliary/internal/usecase"
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
//
// It also puts the same facts in the form the use cases read, because every
// audit entry and every access record carries them and none of them makes a
// decision with them. The source port comes from the connection: an address
// behind carrier-grade NAT identifies thousands of subscribers, and the Marco
// Civil's records are worth little without it.
func identify(trustProxy bool) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := &requestInfo{
				ID:       uuid.NewV7().String(),
				ClientIP: rawClientIP(r, trustProxy),
			}
			info.TraceID, info.ParentSpanID, _ = parseTraceparent(r.Header.Get("traceparent"))
			w.Header().Set("X-Request-ID", info.ID)

			ctx := context.WithValue(r.Context(), requestInfoKey, info)
			ctx = usecase.WithRequestInfo(ctx, usecase.RequestInfo{
				RequestID: info.ID,
				IP:        parseAddr(info.ClientIP),
				Port:      clientPort(r, trustProxy),
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// parseAddr turns the address into the form the records store, or nil when it
// is not an address at all.
func parseAddr(ip string) *netip.Addr {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return nil
	}
	addr = addr.Unmap()
	return &addr
}

// clientPort is the source port of the connection, or of the proxy's
// X-Forwarded-Port when one is trusted.
func clientPort(r *http.Request, trustProxy bool) int {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-Port"); forwarded != "" {
			if port, err := strconv.Atoi(strings.TrimSpace(forwarded)); err == nil && port > 0 && port < 65536 {
				return port
			}
		}
	}
	_, rawPort, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return 0
	}
	return port
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

// --- authentication and authorisation ---------------------------------------

const callerContextKey contextKey = iota + 1

// callerFrom returns the authenticated caller. It panics when called on a
// route that is not behind requireAuth, which is a wiring mistake rather than
// a runtime condition worth handling.
func callerFrom(ctx context.Context) *usecase.Caller {
	caller, ok := ctx.Value(callerContextKey).(*usecase.Caller)
	if !ok {
		panic("http: handler requires authentication but is not behind requireAuth")
	}
	return caller
}

// requireAuth rejects a request without a valid access token and puts the
// caller, with the membership read from the database, in the context.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := bearerToken(r)
		if !ok {
			// RFC 6750: a 401 advertises the scheme the client should use.
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeFailure(w, s.logger, http.StatusUnauthorized, codeUnauthorized, "authentication required")
			return
		}
		access, err := s.signer.ParseAccess(raw)
		if err != nil {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, s.logger, err)
			return
		}
		caller, err := s.identity.Authenticate(r.Context(), access)
		if err != nil {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, s.logger, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerContextKey, caller)))
	})
}

// requireAdmin refuses what only an administrator may do.
//
// The use cases check this again themselves. Twice is deliberate: the
// middleware keeps a route from being exposed by mistake, and the use case
// keeps the rule true no matter who calls it.
func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !callerFrom(r.Context()).IsAdmin() {
			writeFailure(w, s.logger, http.StatusForbidden, codeForbidden, "only an administrator may do this")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireEnrolled holds an administrator without a second factor to the
// enrolment endpoints.
//
// The session is real, so nothing has to be re-typed once the factor is on;
// what it may reach is what changes. The code says which state it is in, so a
// client can send the person straight to the setup screen instead of guessing
// from a bare 403.
func (s *Server) requireEnrolled(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if callerFrom(r.Context()).MFAEnrollmentRequired {
			writeFailure(w, s.logger, http.StatusForbidden, codeMFAEnrollment,
				"enable the second factor to continue")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bearerToken extracts the credential from an Authorization header.
func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	scheme, credential, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	credential = strings.TrimSpace(credential)
	return credential, credential != ""
}

// --- rate limits ------------------------------------------------------------

// limitGlobal charges every request to the client's address.
func (s *Server) limitGlobal(next http.Handler) http.Handler {
	return s.limitByIP(s.opts.Limiters.Global, next)
}

// limitCredentials charges the endpoints where a secret can be guessed.
func (s *Server) limitCredentials(next http.Handler) http.Handler {
	return s.limitByIP(s.opts.Limiters.Credentials, next)
}

func (s *Server) limitByIP(limiter *ratelimit.Limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if limiter == nil {
			next.ServeHTTP(w, r)
			return
		}
		if allowed, retryAfter := limiter.Allow(rateKey(infoFrom(r.Context()).ClientIP)); !allowed {
			s.rejectRateLimited(w, retryAfter)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// limitWrites bounds the authenticated operations that change something,
// keyed by account: a client coming from many addresses is still one account.
func (s *Server) limitWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limiter := s.opts.Limiters.Write
		if limiter == nil {
			next.ServeHTTP(w, r)
			return
		}
		if allowed, retryAfter := limiter.Allow(callerFrom(r.Context()).User.ID.String()); !allowed {
			s.rejectRateLimited(w, retryAfter)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rejectRateLimited(w http.ResponseWriter, retryAfter time.Duration) {
	// Retry-After is expressed in whole seconds, rounded up so a client that
	// obeys it never returns while still short of a token.
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeFailure(w, s.logger, http.StatusTooManyRequests, codeRateLimited, "too many requests")
}

// rateKey is the identity a request is charged to.
//
// An IPv4 address is one key. An IPv6 address is not: a single customer is
// routinely handed a whole /64, so keying each address separately would let
// one client rotate its source address on every request and never meet a
// limit, the credential limit included. Copied from docgen, where that was
// found and fixed.
func rateKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
}
