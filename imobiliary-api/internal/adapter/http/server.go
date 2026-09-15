package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"imobiliary/internal/platform/metrics"
)

// readinessTimeout bounds how long a readiness probe waits on the database.
const readinessTimeout = 2 * time.Second

// Options wires the server's dependencies.
type Options struct {
	Logger  *slog.Logger
	Metrics *metrics.Registry
	// Ready reports whether the service can do its work, which today means the
	// database answers.
	Ready             func(context.Context) error
	TrustProxyHeaders bool
	MaxRequestBytes   int64
}

// Server holds the HTTP API.
type Server struct {
	logger   *slog.Logger
	ready    func(context.Context) error
	observer *observer
	opts     Options
}

// NewServer builds the API server.
func NewServer(opts Options) *Server {
	return &Server{
		logger:   opts.Logger,
		ready:    opts.Ready,
		observer: newObserver(opts.Logger, opts.Metrics),
		opts:     opts,
	}
}

// Handler returns the root handler with every middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleLive)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("/", s.handleNotFound)

	return chain(mux,
		recoverPanics(s.logger),
		identify(s.opts.TrustProxyHeaders),
		secureHeaders,
		limitBody(s.opts.MaxRequestBytes),
		// Innermost: see observer.observe.
		s.observer.observe,
	)
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
