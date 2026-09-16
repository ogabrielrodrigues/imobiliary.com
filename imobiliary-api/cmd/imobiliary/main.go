// Command imobiliary runs the rental management API.
//
// Usage:
//
//	imobiliary serve     run the API (the default)
//	imobiliary migrate   apply pending database migrations, then exit
//
// The two are separate because they connect as different roles. Migrations
// run as the owner of the schema; the service runs as a role that cannot
// change it, and refuses to start while a migration is pending.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	// Windows ships no zone database, and "today" is always computed in
	// America/Sao_Paulo. Embedding the database keeps that true everywhere.
	_ "time/tzdata"

	adapterhttp "imobiliary/internal/adapter/http"
	"imobiliary/internal/adapter/postgres"
	"imobiliary/internal/platform/config"
	"imobiliary/internal/platform/fieldcrypt"
	"imobiliary/internal/platform/logging"
	"imobiliary/internal/platform/metrics"
)

// Timeouts applied to the HTTP servers. net/http applies none by default, so a
// single slow client could otherwise hold a connection open indefinitely.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 2 * time.Minute
	maxHeaderBytes    = 1 << 16
)

func main() {
	if err := config.LoadDotEnv(".env"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	logger := logging.New(os.Stdout, logging.ParseLevel(os.Getenv("IMOBILIARY_LOG_LEVEL")))

	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}

	var err error
	switch command {
	case "serve":
		err = serve(logger)
	case "migrate":
		err = migrate(logger)
	default:
		err = fmt.Errorf("unknown command %q; use serve or migrate", command)
	}
	if err != nil {
		logger.Error("stopped", slog.String("command", command), slog.Any("error", err))
		os.Exit(1)
	}
}

func migrate(logger *slog.Logger) error {
	cfg, err := config.LoadMigrator()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	applied, err := postgres.Migrate(ctx, cfg.DatabaseURL, logger)
	if err != nil {
		return err
	}
	logger.Info("migrations complete", slog.Int("applied", len(applied)))
	return nil
}

func serve(logger *slog.Logger) error {
	// The first interrupt begins a graceful shutdown; a second one terminates
	// the process outright.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}

	keyring, err := fieldcrypt.New(cfg.FieldKeys, cfg.IndexKey)
	if err != nil {
		return err
	}

	db, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.RequireCurrentSchema(ctx); err != nil {
		return err
	}

	registry := metrics.NewRegistry()
	api := adapterhttp.NewServer(adapterhttp.Options{
		Logger:            logger,
		Metrics:           registry,
		Ready:             db.Ping,
		TrustProxyHeaders: cfg.TrustProxyHeaders,
		MaxRequestBytes:   cfg.MaxRequestBytes,
	})

	metricsMux := http.NewServeMux()
	metricsMux.Handle("GET /metrics", registry.Handler())

	servers := []*http.Server{
		newHTTPServer(cfg.Addr, api.Handler(), logger),
		newHTTPServer(cfg.MetricsAddr, metricsMux, logger),
	}

	serverErrors := make(chan error, len(servers))
	for _, s := range servers {
		go func() { serverErrors <- s.ListenAndServe() }()
	}
	logger.Info("listening",
		slog.String("addr", cfg.Addr),
		slog.String("metrics_addr", cfg.MetricsAddr),
		// Not "key" in the name: the redactor would hide a version number
		// operators need in order to know which seal is active.
		slog.Int("field_seal_version", int(keyring.CurrentVersion())),
	)

	var runErr error
	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			runErr = err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		// Stop reacting to signals so a second one kills the process rather
		// than being swallowed here.
		stop()
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	for _, s := range servers {
		if err := s.Shutdown(shutdownCtx); err != nil {
			// In-flight requests outlived the grace period; drop them rather
			// than hang.
			s.Close()
			runErr = errors.Join(runErr, err)
		}
	}
	return runErr
}

func newHTTPServer(addr string, handler http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}
