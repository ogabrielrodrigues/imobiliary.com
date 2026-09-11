package http

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"uuid"

	"docgen/internal/platform/ratelimit"
	"docgen/internal/usecase"
)

// Pagination defaults applied to every listing endpoint.
const (
	defaultPageSize = 20
	maxPageSize     = 100
)

// uploadOverhead is the slack allowed above the template size limit to cover
// multipart framing: boundaries, part headers and the other form fields.
const uploadOverhead = 1 << 20

// Limiters groups the layered rate limiters the server applies.
type Limiters struct {
	// Global is keyed by client IP and covers every request.
	Global *ratelimit.Limiter
	// Auth is keyed by client IP and guards the credential endpoints.
	Auth *ratelimit.Limiter
	// Write is keyed by account and covers uploading and generating.
	Write *ratelimit.Limiter
}

// Options collects everything the server needs.
type Options struct {
	Identity  *usecase.Identity
	Templates *usecase.Templates
	Documents *usecase.Documents
	Privacy   *usecase.Privacy
	Passwords *usecase.Passwords
	Stats     *usecase.Stats
	Limiters  Limiters
	Logger    *slog.Logger
	// Health reports whether dependencies are reachable.
	Health func(context.Context) error

	MaxRequestBytes   int64
	MaxUploadBytes    int64
	TrustProxyHeaders bool
}

// Server turns the use cases into HTTP endpoints.
type Server struct {
	identity  *usecase.Identity
	templates *usecase.Templates
	documents *usecase.Documents
	privacy   *usecase.Privacy
	passwords *usecase.Passwords
	stats     *usecase.Stats
	limiters  Limiters
	logger    *slog.Logger
	health    func(context.Context) error

	maxRequestBytes   int64
	maxUploadBytes    int64
	trustProxyHeaders bool
}

// NewServer builds a server from its dependencies.
func NewServer(opts Options) *Server {
	return &Server{
		identity:          opts.Identity,
		templates:         opts.Templates,
		documents:         opts.Documents,
		privacy:           opts.Privacy,
		passwords:         opts.Passwords,
		stats:             opts.Stats,
		limiters:          opts.Limiters,
		logger:            opts.Logger,
		health:            opts.Health,
		maxRequestBytes:   opts.MaxRequestBytes,
		maxUploadBytes:    opts.MaxUploadBytes,
		trustProxyHeaders: opts.TrustProxyHeaders,
	}
}

// Handler builds the routing table.
//
// http.ServeMux has understood method and wildcard patterns since Go 1.22,
// which is what makes a third-party router unnecessary here.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// credentials adds the strict per-IP limit that makes password and token
	// guessing impractical.
	credentials := func(h http.HandlerFunc) http.Handler {
		return chain(h,
			limitBody(s.maxRequestBytes),
			limitPerIP(s.limiters.Auth, s.trustProxyHeaders, s.logger),
		)
	}
	// read is authenticated but cheap, so it carries only the global limit.
	read := func(h http.HandlerFunc) http.Handler {
		return s.requireAuth(h)
	}
	// write is authenticated and expensive: rendering a document or parsing an
	// uploaded archive. It is additionally limited per account.
	write := func(h http.HandlerFunc, maxBytes int64) http.Handler {
		return s.requireAuth(chain(h,
			limitBody(maxBytes),
			limitPerUser(s.limiters.Write, s.logger),
		))
	}

	// credentialed is authenticated, like read, but charged to the strict
	// per-IP budget rather than the write one. Guessing a password is guessing
	// a password whether or not the guesser already holds a session, and no
	// existing wrapper does both.
	credentialed := func(h http.HandlerFunc) http.Handler {
		return s.requireAuth(chain(h,
			limitBody(s.maxRequestBytes),
			limitPerIP(s.limiters.Auth, s.trustProxyHeaders, s.logger),
		))
	}

	mux.Handle("GET /healthz", http.HandlerFunc(s.handleHealth))

	mux.Handle("POST /v1/auth/register", credentials(s.handleRegister))
	mux.Handle("POST /v1/auth/login", credentials(s.handleLogin))
	mux.Handle("POST /v1/auth/refresh", credentials(s.handleRefresh))
	mux.Handle("POST /v1/auth/logout", credentials(s.handleLogout))
	mux.Handle("POST /v1/auth/password/forgot", credentials(s.handleForgotPassword))
	mux.Handle("POST /v1/auth/password/reset", credentials(s.handleResetPassword))

	mux.Handle("GET /v1/me", read(s.handleMe))
	mux.Handle("GET /v1/me/stats", read(s.handleStats))
	mux.Handle("POST /v1/me/password", credentialed(s.handleChangePassword))
	// The data-subject rights of article 18. Erasure is a mutation and is
	// charged to the write budget; the export is a read, but an expensive one,
	// so it is charged too.
	mux.Handle("GET /v1/me/export", write(s.handleExportAccount, s.maxRequestBytes))
	mux.Handle("DELETE /v1/me", write(s.handleDeleteAccount, s.maxRequestBytes))

	uploadLimit := s.maxUploadBytes + uploadOverhead
	mux.Handle("POST /v1/templates", write(s.handleCreateTemplate, uploadLimit))
	mux.Handle("GET /v1/templates", read(s.handleListTemplates))
	mux.Handle("GET /v1/templates/{id}", read(s.handleGetTemplate))
	mux.Handle("POST /v1/templates/{id}/versions", write(s.handleAddTemplateVersion, uploadLimit))
	mux.Handle("GET /v1/templates/{id}/versions", read(s.handleListTemplateVersions))
	mux.Handle("GET /v1/templates/{id}/versions/{version}/file", read(s.handleDownloadTemplateVersion))
	// Deleting is a mutation, so it is charged to the per-account write budget
	// like every other one. The body limit is inert on a request without a body.
	mux.Handle("DELETE /v1/templates/{id}", write(s.handleDeleteTemplate, s.maxRequestBytes))

	mux.Handle("POST /v1/documents", write(s.handleGenerateDocument, s.maxRequestBytes))
	mux.Handle("GET /v1/documents", read(s.handleListDocuments))
	mux.Handle("GET /v1/documents/{id}", read(s.handleGetDocument))
	mux.Handle("GET /v1/documents/{id}/download", read(s.handleDownloadDocument))
	mux.Handle("DELETE /v1/documents/{id}", write(s.handleDeleteDocument, s.maxRequestBytes))

	// Outermost first: a panic anywhere below is caught, every request is
	// logged, and the global per-IP limit is charged before any work is done.
	return chain(mux,
		recoverPanics(s.logger),
		logRequests(s.logger),
		limitPerIP(s.limiters.Global, s.trustProxyHeaders, s.logger),
	)
}

// handleHealth reports whether the service can serve traffic.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if s.health != nil {
		if err := s.health(r.Context()); err != nil {
			s.logger.Error("health check failed", slog.Any("error", err))
			writeFailure(w, s.logger, http.StatusServiceUnavailable, codeInternal, "service unavailable")
			return
		}
	}
	writeJSON(w, s.logger, http.StatusOK, map[string]string{"status": "ok"})
}

// pathID reads a UUID from a path wildcard.
func pathID(r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil(), false
	}
	return id, true
}

// pagination reads the limit and offset query parameters, clamping them to a
// sane range so a client cannot ask for an unbounded page.
func pagination(r *http.Request) (limit, offset int) {
	limit = defaultPageSize
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = min(parsed, maxPageSize)
		}
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			offset = parsed
		}
	}
	return limit, offset
}
