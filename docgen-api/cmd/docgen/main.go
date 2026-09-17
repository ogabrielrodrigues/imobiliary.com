// Command docgen runs the document generation API.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	adapterhttp "docgen/internal/adapter/http"
	"docgen/internal/adapter/sqlite"
	"docgen/internal/platform/blob"
	"docgen/internal/platform/config"
	"docgen/internal/platform/ratelimit"
	"docgen/internal/platform/token"
	"docgen/internal/usecase"
)

// Timeouts applied to the HTTP server. Every one of them is set explicitly:
// net/http applies none by default, so a single slow client could otherwise
// hold a connection open indefinitely.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 2 * time.Minute
	writeTimeout      = 2 * time.Minute
	idleTimeout       = 2 * time.Minute
	maxHeaderBytes    = 1 << 16
)

// templateCacheSize is how many compiled templates are kept in memory.
const templateCacheSize = 128

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(logger); err != nil {
		logger.Error("service stopped", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	// The context is cancelled on the first interrupt, which begins a graceful
	// shutdown; a second signal terminates the process outright.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	db, err := sqlite.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()

	blobs, err := blob.New(cfg.BlobDir)
	if err != nil {
		return err
	}

	publicKeys, err := token.ParsePublicKeys(cfg.IdentityPublicKeys)
	if err != nil {
		return err
	}
	verifier, err := token.NewVerifier(publicKeys)
	if err != nil {
		return err
	}

	owners := sqlite.NewOwnerRepository(db)
	templates := sqlite.NewTemplateRepository(db)
	documents := sqlite.NewDocumentRepository(db)
	batches := sqlite.NewBatchRepository(db)

	cache := usecase.NewTemplateCache(templateCacheSize)

	access := usecase.NewAccess(usecase.AccessConfig{Verifier: verifier, Owners: owners, Logger: logger})
	templateService := usecase.NewTemplates(usecase.TemplatesConfig{
		Repo:      templates,
		Blobs:     blobs,
		Cache:     cache,
		MaxUpload: cfg.MaxTemplateBytes,
	})
	documentService := usecase.NewDocuments(usecase.DocumentsConfig{
		Templates: templates,
		Documents: documents,
		Batches:   batches,
		Blobs:     blobs,
		Cache:     cache,
	})

	privacyService := usecase.NewPrivacy(usecase.PrivacyConfig{
		Owners:    owners,
		Templates: templates,
		Documents: documents,
		Batches:   batches,
		Blobs:     blobs,
		Logger:    logger,
	})

	limiters := adapterhttp.Limiters{
		Global: newLimiter(cfg.RateLimits.GlobalPerIP),
		Write:  newLimiter(cfg.RateLimits.WritePerUser),
	}
	defer func() {
		limiters.Global.Close()
		limiters.Write.Close()
	}()

	server := adapterhttp.NewServer(adapterhttp.Options{
		Access:    access,
		Templates: templateService,
		Documents: documentService,
		Privacy:   privacyService,
		Stats:     usecase.NewStats(usecase.StatsConfig{Repo: sqlite.NewStatsRepository(db)}),
		Batches: usecase.NewBatches(usecase.BatchesConfig{
			Templates: templates,
			Batches:   batches,
			Documents: documents,
			Blobs:     blobs,
		}),
		Limiters:          limiters,
		Logger:            logger,
		Health:            db.Ping,
		MaxRequestBytes:   cfg.MaxRequestBytes,
		MaxUploadBytes:    cfg.MaxTemplateBytes,
		TrustProxyHeaders: cfg.TrustProxyHeaders,
	})

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	// The listener runs in its own goroutine so this one can wait on the
	// shutdown signal.
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("listening",
			slog.String("addr", cfg.Addr),
			slog.String("database", cfg.DatabasePath),
		)
		serverErrors <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err

	case <-ctx.Done():
		logger.Info("shutting down")

		// Stop reacting to signals so a second one kills the process rather
		// than being swallowed by this handler.
		stop()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()

		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			// In-flight requests outlived the grace period; drop them rather
			// than hang.
			httpServer.Close()
			return err
		}
		return nil
	}
}

func newLimiter(rule config.Rule) *ratelimit.Limiter {
	return ratelimit.New(rule.Rate, rule.Burst)
}
