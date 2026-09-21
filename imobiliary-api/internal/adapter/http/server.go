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
	Properties    *usecase.Properties
	Contracts     *usecase.Contracts
	Rents         *usecase.Rents
	Payouts       *usecase.Payouts
	Documents     *usecase.Documents
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
	properties    *usecase.Properties
	contracts     *usecase.Contracts
	rents         *usecase.Rents
	payouts       *usecase.Payouts
	documents     *usecase.Documents
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
		properties:    opts.Properties,
		contracts:     opts.Contracts,
		rents:         opts.Rents,
		payouts:       opts.Payouts,
		documents:     opts.Documents,
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
	// A short token for the document service, which verifies it with the
	// public key alone (PLANO-FASE-7.md §4).
	mux.Handle("POST /v1/sessions/docgen-token", authenticated(http.HandlerFunc(s.handleDocgenToken)))
	mux.Handle("POST /v1/me/password", write(http.HandlerFunc(s.handleChangePassword)))
	mux.Handle("DELETE /v1/me/totp", write(http.HandlerFunc(s.handleDisableMFA)))
	mux.Handle("POST /v1/me/totp/recovery-codes", write(http.HandlerFunc(s.handleRegenerateRecoveryCodes)))

	mux.Handle("GET /v1/organization", authenticated(http.HandlerFunc(s.handleOrganization)))
	mux.Handle("PATCH /v1/organization", admin(http.HandlerFunc(s.handleRenameOrganization)))
	mux.Handle("GET /v1/organization/administrator", authenticated(http.HandlerFunc(s.handleAdministrator)))
	mux.Handle("PUT /v1/organization/administrator", admin(http.HandlerFunc(s.handleSetAdministrator)))
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
	// Anonymisation at the end of the legal retention: every member sees who is
	// due, and an administrator confirms each one.
	mux.Handle("GET /v1/people/anonymization-candidates", authenticated(http.HandlerFunc(s.handleAnonymizationCandidates)))
	mux.Handle("POST /v1/people/{personID}/anonymization", admin(http.HandlerFunc(s.handleAnonymizePerson)))

	// Properties, likewise.
	mux.Handle("GET /v1/properties", authenticated(http.HandlerFunc(s.handleListProperties)))
	mux.Handle("POST /v1/properties", write(http.HandlerFunc(s.handleCreateProperty)))
	mux.Handle("GET /v1/properties/{propertyID}", authenticated(http.HandlerFunc(s.handleGetProperty)))
	mux.Handle("PUT /v1/properties/{propertyID}", write(http.HandlerFunc(s.handleUpdateProperty)))
	mux.Handle("DELETE /v1/properties/{propertyID}", write(http.HandlerFunc(s.handleDeleteProperty)))

	// Contracts. The preview writes nothing and is still charged as a write:
	// it runs the same reads and rules as a creation.
	mux.Handle("GET /v1/contracts", authenticated(http.HandlerFunc(s.handleListContracts)))
	mux.Handle("POST /v1/contracts", write(http.HandlerFunc(s.handleCreateContract)))
	mux.Handle("POST /v1/contracts/preview", write(http.HandlerFunc(s.handlePreviewContract)))
	mux.Handle("GET /v1/contracts/{contractID}", authenticated(http.HandlerFunc(s.handleGetContract)))
	mux.Handle("PUT /v1/contracts/{contractID}", write(http.HandlerFunc(s.handleUpdateContract)))
	mux.Handle("POST /v1/contracts/{contractID}/termination", write(http.HandlerFunc(s.handleTerminateContract)))
	mux.Handle("DELETE /v1/contracts/{contractID}", write(http.HandlerFunc(s.handleDeleteContract)))
	mux.Handle("GET /v1/contracts/{contractID}/document-fields", authenticated(http.HandlerFunc(s.handleContractDocumentFields)))
	mux.Handle("POST /v1/contracts/{contractID}/amendments/preview", write(http.HandlerFunc(s.handlePreviewAmendment)))
	mux.Handle("POST /v1/contracts/{contractID}/amendments", write(http.HandlerFunc(s.handleCreateAmendment)))
	mux.Handle("DELETE /v1/contracts/{contractID}/amendments/{amendmentID}", write(http.HandlerFunc(s.handleDeleteAmendment)))

	// Rents and the dashboard. The payment preview writes nothing and is
	// charged as a write, like the other previews.
	mux.Handle("GET /v1/rents", authenticated(http.HandlerFunc(s.handleListRents)))
	mux.Handle("GET /v1/rents/{rentID}", authenticated(http.HandlerFunc(s.handleGetRent)))
	mux.Handle("POST /v1/rents/{rentID}/payment/preview", write(http.HandlerFunc(s.handlePreviewPayment)))
	mux.Handle("POST /v1/rents/{rentID}/payment", write(http.HandlerFunc(s.handlePayRent)))
	mux.Handle("DELETE /v1/rents/{rentID}/payment", write(http.HandlerFunc(s.handleReversePayment)))
	mux.Handle("POST /v1/rents/{rentID}/charges", write(http.HandlerFunc(s.handleAddCharge)))
	mux.Handle("DELETE /v1/rents/{rentID}/charges/{chargeID}", write(http.HandlerFunc(s.handleRemoveCharge)))
	mux.Handle("PATCH /v1/rents/{rentID}/charges/{chargeID}", write(http.HandlerFunc(s.handleChargeDestination)))
	mux.Handle("GET /v1/dashboard", authenticated(http.HandlerFunc(s.handleDashboard)))

	// The owners' ledger and payouts (PLANO-REPASSE.md). Recording a payout
	// moves no money: it says the office already did.
	mux.Handle("GET /v1/payouts/balances", authenticated(http.HandlerFunc(s.handleBalances)))
	mux.Handle("GET /v1/people/{personID}/ledger", authenticated(http.HandlerFunc(s.handlePersonLedger)))
	mux.Handle("POST /v1/people/{personID}/ledger", write(http.HandlerFunc(s.handleAddLedgerEntry)))
	mux.Handle("GET /v1/people/{personID}/income-report", authenticated(http.HandlerFunc(s.handleIncomeReport)))
	mux.Handle("DELETE /v1/ledger/{entryID}", write(http.HandlerFunc(s.handleDeleteLedgerEntry)))
	mux.Handle("GET /v1/payouts", authenticated(http.HandlerFunc(s.handleListPayouts)))
	mux.Handle("POST /v1/payouts", write(http.HandlerFunc(s.handleCreatePayout)))
	mux.Handle("GET /v1/payouts/{payoutID}", authenticated(http.HandlerFunc(s.handleGetPayout)))
	mux.Handle("DELETE /v1/payouts/{payoutID}", write(http.HandlerFunc(s.handleUndoPayout)))
	mux.Handle("GET /v1/payouts/{payoutID}/document-fields", authenticated(http.HandlerFunc(s.handlePayoutDocumentFields)))

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
