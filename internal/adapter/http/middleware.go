package http

import (
	"context"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"docgen/internal/domain"
	"docgen/internal/platform/ratelimit"
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

const userContextKey contextKey = iota

// userFrom returns the authenticated account attached by requireAuth. It panics
// if called on an unauthenticated route, which would be a wiring mistake rather
// than a runtime condition worth handling.
func userFrom(ctx context.Context) *domain.User {
	user, ok := ctx.Value(userContextKey).(*domain.User)
	if !ok {
		panic("http: handler requires authentication but is not behind requireAuth")
	}
	return user
}

// statusRecorder remembers what a handler wrote, for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
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

// recoverPanics turns a panic in a handler into a 500 instead of killing the
// process and dropping every other in-flight request.
func recoverPanics(logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error("handler panicked",
						slog.Any("panic", recovered),
						slog.String("method", r.Method),
						slog.String("path", r.URL.Path),
					)
					writeFailure(w, logger, http.StatusInternalServerError, codeInternal, "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// logRequests records one line per request.
func logRequests(logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			recorder := &statusRecorder{ResponseWriter: w}

			next.ServeHTTP(recorder, r)

			if recorder.status == 0 {
				recorder.status = http.StatusOK
			}
			logger.Info("request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", recorder.status),
				slog.Int64("bytes", recorder.bytes),
				slog.Duration("duration", time.Since(started)),
			)
		})
	}
}

// limitBody caps how much a client may send, so a slow endless upload cannot
// consume memory indefinitely.
func limitBody(maxBytes int64) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// limitPerIP applies a token bucket keyed by client address.
func limitPerIP(limiter *ratelimit.Limiter, trustProxy bool, logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if allowed, retryAfter := limiter.Allow(clientIP(r, trustProxy)); !allowed {
				rejectRateLimited(w, logger, retryAfter)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// limitPerUser applies a token bucket keyed by account. It sits behind
// requireAuth, where the caller is already known, and bounds the operations
// that cost real work regardless of how many addresses a client comes from.
func limitPerUser(limiter *ratelimit.Limiter, logger *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := userFrom(r.Context())
			if allowed, retryAfter := limiter.Allow(user.ID.String()); !allowed {
				rejectRateLimited(w, logger, retryAfter)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func rejectRateLimited(w http.ResponseWriter, logger *slog.Logger, retryAfter time.Duration) {
	// Retry-After is expressed in whole seconds, rounded up so a client that
	// obeys it never returns while still short of a token.
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeFailure(w, logger, http.StatusTooManyRequests, codeRateLimited, "too many requests")
}

// requireAuth rejects a request that carries no valid access token, and puts
// the resolved account in the request context.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := bearerToken(r)
		if !ok {
			// RFC 6750: a 401 advertises the scheme the client should use.
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeFailure(w, s.logger, http.StatusUnauthorized, codeUnauthorized, "authentication required")
			return
		}

		user, err := s.identity.Authenticate(r.Context(), raw)
		if err != nil {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, s.logger, err)
			return
		}

		ctx := context.WithValue(r.Context(), userContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
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
	if credential == "" {
		return "", false
	}
	return credential, true
}

// clientIP determines who to charge for a request.
//
// X-Forwarded-For is honoured only when the deployment declares that a trusted
// proxy sets it. Trusting it unconditionally would let any client pick its own
// rate-limit key by sending a header, which is the same as having no per-IP
// limit at all.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			// The left-most entry is the original client; the rest were added
			// by intermediaries.
			if first, _, found := strings.Cut(forwarded, ","); found {
				forwarded = first
			}
			if ip := strings.TrimSpace(forwarded); ip != "" {
				return ip
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
