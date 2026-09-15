// Package config loads runtime settings from the environment.
//
// Every secret fails closed: a missing or short key stops the process at
// start-up instead of letting it run with no protection, or with a default
// that every deployment would share.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"imobiliary/internal/platform/fieldcrypt"
	"imobiliary/internal/platform/logging"
)

// Server is the configuration of the API process.
type Server struct {
	// Addr is where the API listens. Loopback by default: the API is reached
	// only by the platform's server, and exposing it takes a decision.
	Addr string
	// MetricsAddr serves /metrics on its own listener, so the scrape endpoint
	// is never reachable through whatever proxy fronts the API.
	MetricsAddr string

	// DatabaseURL connects as the application role, which owns no table and
	// cannot change the schema. Migrations use a different role.
	DatabaseURL string

	// FieldKeys seal personal data in the database, by key version.
	FieldKeys map[byte][]byte
	// IndexKey derives the blind indexes of sealed fields.
	IndexKey []byte

	// TrustProxyHeaders enables reading the client address from
	// X-Forwarded-For. Honouring it without a trusted proxy in front would let
	// any client choose the address it is logged and rate-limited under.
	TrustProxyHeaders bool

	LogLevel        slog.Level
	MaxRequestBytes int64
	ShutdownTimeout time.Duration
}

// Migrator is the configuration of the migrate command.
type Migrator struct {
	// DatabaseURL connects as the role that owns the schema.
	DatabaseURL string
}

// LoadServer reads the API configuration.
func LoadServer() (*Server, error) {
	cfg := &Server{
		Addr:              env("IMOBILIARY_ADDR", "127.0.0.1:8081"),
		MetricsAddr:       env("IMOBILIARY_METRICS_ADDR", "127.0.0.1:9181"),
		DatabaseURL:       os.Getenv("IMOBILIARY_DATABASE_URL"),
		TrustProxyHeaders: envBool("IMOBILIARY_TRUST_PROXY_HEADERS", false),
		LogLevel:          logging.ParseLevel(os.Getenv("IMOBILIARY_LOG_LEVEL")),
	}

	if cfg.DatabaseURL == "" {
		return nil, errors.New("config: IMOBILIARY_DATABASE_URL must be set")
	}
	if cfg.Addr == cfg.MetricsAddr {
		return nil, errors.New("config: IMOBILIARY_METRICS_ADDR must differ from IMOBILIARY_ADDR")
	}

	var err error
	if cfg.FieldKeys, err = fieldcrypt.ParseKeys(os.Getenv("IMOBILIARY_FIELD_KEYS")); err != nil {
		return nil, fmt.Errorf("config: IMOBILIARY_FIELD_KEYS: %w", err)
	}
	if len(cfg.FieldKeys) == 0 {
		return nil, errors.New("config: IMOBILIARY_FIELD_KEYS must hold at least one key, as 1:<base64 of 32 bytes>")
	}
	if cfg.IndexKey, err = fieldcrypt.DecodeKey(os.Getenv("IMOBILIARY_INDEX_KEY")); err != nil {
		return nil, fmt.Errorf("config: IMOBILIARY_INDEX_KEY: %w", err)
	}
	if cfg.MaxRequestBytes, err = envInt64("IMOBILIARY_MAX_REQUEST_BYTES", 1<<20); err != nil {
		return nil, err
	}
	if cfg.ShutdownTimeout, err = envDuration("IMOBILIARY_SHUTDOWN_TIMEOUT", 15*time.Second); err != nil {
		return nil, err
	}
	return cfg, nil
}

// LoadMigrator reads the migrate command's configuration.
func LoadMigrator() (*Migrator, error) {
	url := os.Getenv("IMOBILIARY_MIGRATION_DATABASE_URL")
	if url == "" {
		return nil, errors.New("config: IMOBILIARY_MIGRATION_DATABASE_URL must be set")
	}
	return &Migrator{DatabaseURL: url}, nil
}

// LoadDotEnv sets variables from a KEY=VALUE file, for development. A missing
// file is not an error, and a variable already set in the environment wins
// over the file, so a deployment's real environment is never overridden by a
// stray file.
//
// Only the plain form is understood: blank lines, comments starting with #,
// and KEY=VALUE with an optional pair of surrounding quotes.
func LoadDotEnv(path string) error {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("config: open %s: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		key, value, found := strings.Cut(text, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return fmt.Errorf("config: %s:%d: expected KEY=VALUE", path, line)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, set := os.LookupEnv(key); set {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("config: %s:%d: %w", path, line, err)
		}
	}
	return scanner.Err()
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v, err := strconv.ParseBool(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return v
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("config: %s: must be positive", key)
	}
	return d, nil
}

func envInt64(key string, fallback int64) (int64, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("config: %s: must be positive", key)
	}
	return n, nil
}
