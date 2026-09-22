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
	"imobiliary/internal/adapter/mail"
	"imobiliary/internal/adapter/postgres"
	"imobiliary/internal/adapter/sealing"
	"imobiliary/internal/platform/config"
	"imobiliary/internal/platform/fieldcrypt"
	"imobiliary/internal/platform/logging"
	"imobiliary/internal/platform/metrics"
	"imobiliary/internal/platform/password"
	"imobiliary/internal/platform/ratelimit"
	"imobiliary/internal/platform/token"
	"imobiliary/internal/usecase"
)

// purgeInterval is how often expired credentials and the access records past
// their six months are swept.
const purgeInterval = time.Hour

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
	case "public-keys":
		err = publicKeys()
	default:
		err = fmt.Errorf("unknown command %q; use serve, migrate or public-keys", command)
	}
	if err != nil {
		logger.Error("stopped", slog.String("command", command), slog.Any("error", err))
		os.Exit(1)
	}
}

// publicKeys prints the verification keys of the access token signer, in the
// form the document service reads from DOCGEN_IDENTITY_PUBLIC_KEYS. They are
// public: printing them reveals nothing that signs.
func publicKeys() error {
	// The server's configuration, so the keys come from the same place,
	// .env included, as the ones the running service signs with.
	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}
	signer, err := token.NewSigner(cfg.TokenKeys, cfg.TokenKeyID, time.Minute)
	if err != nil {
		return err
	}
	fmt.Println(signer.PublicKeySpec())
	return nil
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

	signer, err := token.NewSigner(cfg.TokenKeys, cfg.TokenKeyID, cfg.AccessTokenTTL)
	if err != nil {
		return err
	}

	// Without a provider key the service logs mail instead of sending it, so a
	// development run prints the reset link and the invitation in the terminal
	// and nothing can reach a real person by accident. config.LoadServer
	// already refused to start with neither, so exactly one applies.
	var mailer usecase.Mailer = mail.NewResend(cfg.ResendAPIKey, cfg.MailFrom)
	if cfg.ResendAPIKey == "" {
		logger.Warn("IMOBILIARY_MAIL_LOG is on: mail, including reset links and invitations, is written to this log")
		mailer = mail.NewLogger(logger)
	}

	repos := db.Repositories()
	hasher := password.NewHasher()
	auditor := usecase.NewAuditor(repos.Audit, time.Now, logger)
	sealer := sealing.New(keyring)

	identity := usecase.NewIdentity(usecase.IdentityConfig{
		Repositories: repos,
		Transactor:   db,
		Hasher:       hasher,
		Tokens:       signer,
		Mailer:       mailer,
		RefreshTTL:   cfg.RefreshTokenTTL,
		ChallengeTTL: cfg.ChallengeTTL,
		Logger:       logger,
	})
	mfa := usecase.NewMFA(usecase.MFAConfig{
		Identity:     identity,
		Repositories: repos,
		Sealer:       sealer,
		Logger:       logger,
	})
	passwords := usecase.NewPasswords(usecase.PasswordsConfig{
		Identity:     identity,
		Repositories: repos,
		Hasher:       hasher,
		Mailer:       mailer,
		AppURL:       cfg.AppURL,
		ResetTTL:     cfg.ResetTTL,
		Logger:       logger,
	})
	organizations := usecase.NewOrganizations(usecase.OrganizationsConfig{
		Identity:      identity,
		Sealer:        sealer,
		Repositories:  repos,
		Hasher:        hasher,
		Mailer:        mailer,
		AppURL:        cfg.AppURL,
		InvitationTTL: cfg.InvitationTTL,
		Logger:        logger,
	})
	saoPaulo, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		return fmt.Errorf("load America/Sao_Paulo: %w", err)
	}
	people := usecase.NewPeople(usecase.PeopleConfig{
		Scope:    db,
		Sealer:   sealer,
		Location: saoPaulo,
		Logger:   logger,
	})
	properties := usecase.NewProperties(usecase.PropertiesConfig{
		Scope:  db,
		Logger: logger,
	})
	contracts := usecase.NewContracts(usecase.ContractsConfig{
		Scope:    db,
		Location: saoPaulo,
		Logger:   logger,
	})
	documents := usecase.NewDocuments(usecase.DocumentsConfig{
		Scope: db, People: people, Organizations: organizations, Location: saoPaulo,
	})
	rents := usecase.NewRents(usecase.RentsConfig{
		Scope:    db,
		Location: saoPaulo,
		Logger:   logger,
	})
	payouts := usecase.NewPayouts(usecase.PayoutsConfig{
		Scope:    db,
		Location: saoPaulo,
		Logger:   logger,
	})
	backfillLedger(ctx, db, rents, logger)
	privacy := usecase.NewPrivacy(usecase.PrivacyConfig{
		Identity:     identity,
		Repositories: repos,
		Hasher:       hasher,
		Sealer:       sealer,
		Mailer:       mailer,
		Logger:       logger,
	})

	limiters := adapterhttp.Limiters{
		Global:      newLimiter(cfg.RateLimits.GlobalPerIP),
		Credentials: newLimiter(cfg.RateLimits.CredentialsPerIP),
		Write:       newLimiter(cfg.RateLimits.WritePerUser),
	}
	defer func() {
		limiters.Global.Close()
		limiters.Credentials.Close()
		limiters.Write.Close()
	}()

	registry := metrics.NewRegistry()
	api := adapterhttp.NewServer(adapterhttp.Options{
		Identity:          identity,
		MFA:               mfa,
		Passwords:         passwords,
		Organizations:     organizations,
		Privacy:           privacy,
		People:            people,
		Properties:        properties,
		Contracts:         contracts,
		Rents:             rents,
		Payouts:           payouts,
		Documents:         documents,
		Auditor:           auditor,
		Signer:            signer,
		Logger:            logger,
		Metrics:           registry,
		Ready:             db.Ping,
		Limiters:          limiters,
		TrustProxyHeaders: cfg.TrustProxyHeaders,
		MaxRequestBytes:   cfg.MaxRequestBytes,
	})

	go purgeExpired(ctx, identity, logger)

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

func newLimiter(rule config.Rule) *ratelimit.Limiter {
	return ratelimit.New(rule.Rate, rule.Burst)
}

// purgeExpired sweeps what nobody can use any more: refresh tokens and reset
// links past their expiry, and the access records past the six months the
// Marco Civil asks for. Keeping them longer would be keeping personal data
// with no purpose left.
func purgeExpired(ctx context.Context, identity *usecase.Identity, logger *slog.Logger) {
	ticker := time.NewTicker(purgeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := identity.PurgeExpired(ctx); err != nil {
				logger.Warn("purging expired records failed", slog.Any("error", err))
			}
		}
	}
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

// backfillLedger writes the owners' ledger lines of the rents paid before the
// ledger existed (migration 0012), each office in its own transaction. It runs
// at every start and finds nothing after the first, so no operator has to
// remember it. An office that fails is logged and left for the next start:
// the service still has every other office to serve.
func backfillLedger(ctx context.Context, db *postgres.DB, rents *usecase.Rents, logger *slog.Logger) {
	ids, err := db.OrganizationIDs(ctx)
	if err != nil {
		logger.Error("ledger backfill", slog.Any("error", err))
		return
	}
	for _, id := range ids {
		n, err := rents.BackfillLedger(ctx, id)
		switch {
		case err != nil:
			logger.Error("ledger backfill", slog.String("organization_id", id.String()), slog.Any("error", err))
		case n > 0:
			logger.Info("ledger backfill", slog.String("organization_id", id.String()), slog.Int("rents", n))
		}
	}
}
