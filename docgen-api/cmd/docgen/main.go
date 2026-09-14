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
	"docgen/internal/adapter/mail"
	"docgen/internal/adapter/sqlite"
	"docgen/internal/platform/blob"
	"docgen/internal/platform/config"
	"docgen/internal/platform/password"
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

// sessionCleanupInterval is how often expired refresh tokens are purged.
const sessionCleanupInterval = time.Hour

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

	users := sqlite.NewUserRepository(db)
	sessions := sqlite.NewSessionRepository(db)
	templates := sqlite.NewTemplateRepository(db)
	documents := sqlite.NewDocumentRepository(db)
	batches := sqlite.NewBatchRepository(db)

	cache := usecase.NewTemplateCache(templateCacheSize)

	// Without a provider key the service logs mail instead of sending it, so a
	// development run prints the reset link in the terminal and no message can
	// reach a real person by accident.
	// config.Load already refused to start with neither, so exactly one applies.
	var mailer usecase.Mailer = mail.NewResend(cfg.ResendAPIKey, cfg.MailFrom)
	if cfg.ResendAPIKey == "" {
		logger.Warn("DOCGEN_MAIL_LOG is on: mail, including password-reset links, is written to this log")
		mailer = mail.NewLogger(logger)
	}

	identity := usecase.NewIdentity(usecase.IdentityConfig{
		Users:      users,
		Sessions:   sessions,
		Hasher:     password.NewHasher(),
		Tokens:     token.NewIssuer(cfg.JWTSecret, cfg.AccessTokenTTL),
		Mailer:     mailer,
		RefreshTTL: cfg.RefreshTokenTTL,
		Logger:     logger,
	})
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

	passwordService := usecase.NewPasswords(usecase.PasswordsConfig{
		Users:      users,
		Sessions:   sessions,
		Resets:     sqlite.NewPasswordResetRepository(db),
		Hasher:     password.NewHasher(),
		Tokens:     token.NewIssuer(cfg.JWTSecret, cfg.AccessTokenTTL),
		Mailer:     mailer,
		AppURL:     cfg.AppURL,
		ResetTTL:   cfg.PasswordResetTTL,
		RefreshTTL: cfg.RefreshTokenTTL,
		Logger:     logger,
	})

	privacyService := usecase.NewPrivacy(usecase.PrivacyConfig{
		Users:     users,
		Templates: templates,
		Documents: documents,
		Batches:   batches,
		Blobs:     blobs,
		Logger:    logger,
	})

	limiters := adapterhttp.Limiters{
		Global: newLimiter(cfg.RateLimits.GlobalPerIP),
		Auth:   newLimiter(cfg.RateLimits.AuthPerIP),
		Write:  newLimiter(cfg.RateLimits.WritePerUser),
	}
	defer func() {
		limiters.Global.Close()
		limiters.Auth.Close()
		limiters.Write.Close()
	}()

	server := adapterhttp.NewServer(adapterhttp.Options{
		Identity:  identity,
		Templates: templateService,
		Documents: documentService,
		Privacy:   privacyService,
		Passwords: passwordService,
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

	go purgeExpiredSessions(ctx, sessions, sqlite.NewPasswordResetRepository(db), logger)

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

// purgeExpiredSessions removes refresh tokens that can no longer be used,
// keeping the table from growing without bound.
func purgeExpiredSessions(ctx context.Context, sessions *sqlite.SessionRepository, resets *sqlite.PasswordResetRepository, logger *slog.Logger) {
	ticker := time.NewTicker(sessionCleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			removed, err := sessions.DeleteExpired(ctx, time.Now().UTC())
			if err != nil {
				logger.Warn("purging expired sessions failed", slog.Any("error", err))
				continue
			}
			if removed > 0 {
				logger.Info("purged expired sessions", slog.Int64("count", removed))
			}

			// Reset tokens are swept by the same tick. They are short-lived and
			// spent quickly, so leaving them would accumulate rows that prove
			// nothing anybody needs.
			spent, err := resets.DeleteExpired(ctx, time.Now().UTC())
			if err != nil {
				logger.Warn("purging password resets failed", slog.Any("error", err))
				continue
			}
			if spent > 0 {
				logger.Info("purged password resets", slog.Int64("count", spent))
			}
		}
	}
}
