package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"imobiliary/internal/platform/metrics"
	"imobiliary/internal/platform/ratelimit"
	"imobiliary/internal/platform/token"
	"imobiliary/internal/usecase"
)

// readinessTimeout bounds how long a readiness probe waits on the database.
const readinessTimeout = 2 * time.Second

// Limiters are the layered rate limits.
type Limiters struct {
	// Global applies to every request, keyed by client address.
	Global *ratelimit.Limiter
	// Credentials guards the endpoints where a secret is guessed: sign-in, the
	// second factor, recovery, invitations.
	Credentials *ratelimit.Limiter
	// Write bounds the authenticated operations that change something, keyed
	// by account rather than by address.
	Write *ratelimit.Limiter
}

// Options wires the server's dependencies.
type Options struct {
	Identity      *usecase.Identity
	MFA           *usecase.MFA
	Passwords     *usecase.Passwords
	Organizations *usecase.Organizations
	Privacy       *usecase.Privacy
	People        *usecase.People
	Auditor       *usecase.Auditor
	// Signer parses the access tokens this service issued.
	Signer  *token.Signer
	Logger  *slog.Logger
	Metrics *metrics.Registry
	// Ready reports whether the service can do its work, which today means the
	// database answers.
	Ready             func(context.Context) error
	Limiters          Limiters
	TrustProxyHeaders bool
	MaxRequestBytes   int64
	Now               usecase.Clock
}

// Server holds the HTTP API.
type Server struct {
	identity      *usecase.Identity
	mfa           *usecase.MFA
	passwords     *usecase.Passwords
	organizations *usecase.Organizations
	privacy       *usecase.Privacy
	people        *usecase.People
	auditor       *usecase.Auditor
	signer        *token.Signer
	logger        *slog.Logger
	ready         func(context.Context) error
	observer      *observer
	clock         usecase.Clock
	opts          Options
}

// NewServer builds the API server.
func NewServer(opts Options) *Server {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Server{
		identity:      opts.Identity,
		mfa:           opts.MFA,
		passwords:     opts.Passwords,
		organizations: opts.Organizations,
		privacy:       opts.Privacy,
		people:        opts.People,
		auditor:       opts.Auditor,
		signer:        opts.Signer,
		logger:        opts.Logger,
		ready:         opts.Ready,
		observer:      newObserver(opts.Logger, opts.Metrics),
		clock:         opts.Now,
		opts:          opts,
	}
}

// Handler returns the root handler with every middleware applied.
//
// The route table is the whole surface of the API, which is why it is one
// function: what is public, what needs a session, what needs an administrator
// and what a session still enrolling its second factor may reach are all
// visible here together.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public. Every one of these is charged to the credential limiter as well
	// as the global one: they are where a secret is guessed.
	credentials := chain2(s.limitCredentials)
	mux.Handle("POST /v1/accounts", credentials(http.HandlerFunc(s.handleRegister)))
	mux.Handle("POST /v1/sessions", credentials(http.HandlerFunc(s.handleSignIn)))
	mux.Handle("POST /v1/sessions/mfa", credentials(http.HandlerFunc(s.handleCompleteMFA)))
	mux.Handle("POST /v1/sessions/refresh", credentials(http.HandlerFunc(s.handleRefresh)))
	mux.Handle("POST /v1/sessions/switch", credentials(http.HandlerFunc(s.handleSwitchOrganization)))
	mux.Handle("DELETE /v1/sessions", credentials(http.HandlerFunc(s.handleSignOut)))
	mux.Handle("POST /v1/password/forgot", credentials(http.HandlerFunc(s.handleForgotPassword)))
	mux.Handle("POST /v1/password/reset", credentials(http.HandlerFunc(s.handleResetPassword)))
	mux.Handle("POST /v1/invitations/lookup", credentials(http.HandlerFunc(s.handleLookupInvitation)))
	mux.Handle("POST /v1/invitations/accept", credentials(http.HandlerFunc(s.handleAcceptInvitation)))

	// Enrolling a second factor. Reachable by a session that may do nothing
	// else yet, which is what an administrator's first sign-in looks like.
	enrolling := chain2(s.requireAuth, s.limitWrites)
	mux.Handle("POST /v1/me/totp", enrolling(http.HandlerFunc(s.handleStartEnrollment)))
	mux.Handle("POST /v1/me/totp/confirm", enrolling(http.HandlerFunc(s.handleConfirmEnrollment)))

	// The data subject's rights. Reachable before enrolment as well: someone
	// may want a copy of their data, or to leave, without first being made to
	// set up a second factor. Erasure checks a password, so it is charged to
	// the credential limiter too.
	mux.Handle("GET /v1/me/export", enrolling(http.HandlerFunc(s.handleExport)))
	mux.Handle("POST /v1/me/deletion",
		chain2(s.requireAuth, s.limitCredentials, s.limitWrites)(http.HandlerFunc(s.handleDeleteAccount)))

	// Signed in, and past the enrolment rule.
	authenticated := chain2(s.requireAuth, s.requireEnrolled)
	write := chain2(s.requireAuth, s.requireEnrolled, s.limitWrites)
	admin := chain2(s.requireAuth, s.requireEnrolled, s.requireAdmin, s.limitWrites)

	mux.Handle("GET /v1/me", authenticated(http.HandlerFunc(s.handleMe)))
	mux.Handle("POST /v1/me/password", write(http.HandlerFunc(s.handleChangePassword)))
	mux.Handle("DELETE /v1/me/totp", write(http.HandlerFunc(s.handleDisableMFA)))
	mux.Handle("POST /v1/me/totp/recovery-codes", write(http.HandlerFunc(s.handleRegenerateRecoveryCodes)))

	mux.Handle("GET /v1/organization", authenticated(http.HandlerFunc(s.handleOrganization)))
	mux.Handle("PATCH /v1/organization", admin(http.HandlerFunc(s.handleRenameOrganization)))
	mux.Handle("GET /v1/organization/members", authenticated(http.HandlerFunc(s.handleMembers)))
	mux.Handle("PATCH /v1/organization/members/{userID}", admin(http.HandlerFunc(s.handleChangeRole)))
	mux.Handle("DELETE /v1/organization/members/{userID}", admin(http.HandlerFunc(s.handleRemoveMember)))
	mux.Handle("GET /v1/organization/invitations", admin(http.HandlerFunc(s.handleInvitations)))
	mux.Handle("POST /v1/organization/invitations", admin(http.HandlerFunc(s.handleInvite)))
	mux.Handle("DELETE /v1/organization/invitations/{invitationID}", admin(http.HandlerFunc(s.handleRevokeInvitation)))

	// People: any member manages them, inside their own office.
	mux.Handle("GET /v1/people", authenticated(http.HandlerFunc(s.handleListPeople)))
	mux.Handle("POST /v1/people", write(http.HandlerFunc(s.handleCreatePerson)))
	mux.Handle("GET /v1/people/{personID}", authenticated(http.HandlerFunc(s.handleGetPerson)))
	mux.Handle("PUT /v1/people/{personID}", write(http.HandlerFunc(s.handleUpdatePerson)))
	mux.Handle("DELETE /v1/people/{personID}", write(http.HandlerFunc(s.handleDeletePerson)))

	// Probes, and the catch-all that answers JSON rather than net/http's text.
	mux.HandleFunc("GET /healthz", s.handleLive)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("/", s.handleNotFound)

	return chain(mux,
		recoverPanics(s.logger),
		identify(s.opts.TrustProxyHeaders),
		secureHeaders,
		limitBody(s.opts.MaxRequestBytes),
		s.limitGlobal,
		// Innermost: see observer.observe.
		s.observer.observe,
	)
}

// chain2 composes the per-route middleware, outermost first. It is separate
// from chain only because the route table reads better with the composition
// named once and applied many times.
func chain2(middlewares ...middleware) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler { return chain(h, middlewares...) }
}

type statusBody struct {
	Status string `json:"status"`
}

// handleLive answers as long as the process serves requests. It checks nothing
// else on purpose: a liveness probe that fails when the database is down gets
// a healthy process restarted in a loop.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.logger, http.StatusOK, statusBody{Status: "ok"})
}

// handleReady reports whether the service can take traffic.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
	defer cancel()
	if err := s.ready(ctx); err != nil {
		// The reason goes to the log only; a probe needs a status, and an
		// unauthenticated caller needs nothing about the database.
		s.logger.Warn("not ready", slog.Any("error", err), slog.String("request_id", infoFrom(r.Context()).ID))
		writeFailure(w, s.logger, http.StatusServiceUnavailable, codeUnavailable, "service unavailable")
		return
	}
	writeJSON(w, s.logger, http.StatusOK, statusBody{Status: "ready"})
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	writeFailure(w, s.logger, http.StatusNotFound, codeNotFound, "resource not found")
}
