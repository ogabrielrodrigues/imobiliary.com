// Package config loads runtime settings from the environment.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

// MinJWTSecretLength matches the output size of HMAC-SHA256: a shorter key adds
// no security, and a much shorter one invites brute force.
const MinJWTSecretLength = 32

// Rule is one rate-limit setting: a sustained rate in requests per second and
// the burst a client may spend at once.
type Rule struct {
	Rate  float64
	Burst int
}

// RateLimits groups the layered limits described in the design.
type RateLimits struct {
	// GlobalPerIP applies to every request, keyed by client IP.
	GlobalPerIP Rule
	// AuthPerIP guards the credential endpoints against brute force.
	AuthPerIP Rule
	// WritePerUser bounds the expensive authenticated operations: uploading a
	// template and rendering a document.
	WritePerUser Rule
}

// Config is the fully resolved configuration of the service.
type Config struct {
	Addr            string
	DatabasePath    string
	BlobDir         string
	JWTSecret       []byte
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration

	// TrustProxyHeaders enables reading the client IP from X-Forwarded-For.
	// It defaults to false because that header is trivially forged: honouring
	// it without a trusted proxy in front would turn the per-IP rate limit into
	// decoration.
	TrustProxyHeaders bool

	MaxTemplateBytes int64
	MaxRequestBytes  int64
	ShutdownTimeout  time.Duration
	RateLimits       RateLimits
}

// Load reads the configuration from the environment, applying defaults for
// everything except the JWT secret, which has no safe default.
func Load() (*Config, error) {
	cfg := &Config{
		Addr:              env("DOCGEN_ADDR", ":8080"),
		DatabasePath:      env("DOCGEN_DB_PATH", "data/docgen.db"),
		BlobDir:           env("DOCGEN_BLOB_DIR", "data/blobs"),
		JWTSecret:         []byte(os.Getenv("DOCGEN_JWT_SECRET")),
		TrustProxyHeaders: envBool("DOCGEN_TRUST_PROXY_HEADERS", false),
		ShutdownTimeout:   15 * time.Second,
		RateLimits: RateLimits{
			GlobalPerIP:  Rule{Rate: 10, Burst: 60},
			AuthPerIP:    Rule{Rate: 0.2, Burst: 10},
			WritePerUser: Rule{Rate: 2, Burst: 20},
		},
	}

	var err error
	if cfg.AccessTokenTTL, err = envDuration("DOCGEN_ACCESS_TTL", 15*time.Minute); err != nil {
		return nil, err
	}
	if cfg.RefreshTokenTTL, err = envDuration("DOCGEN_REFRESH_TTL", 30*24*time.Hour); err != nil {
		return nil, err
	}
	if cfg.MaxTemplateBytes, err = envInt64("DOCGEN_MAX_TEMPLATE_BYTES", 10<<20); err != nil {
		return nil, err
	}
	if cfg.MaxRequestBytes, err = envInt64("DOCGEN_MAX_REQUEST_BYTES", 1<<20); err != nil {
		return nil, err
	}

	if len(cfg.JWTSecret) < MinJWTSecretLength {
		return nil, fmt.Errorf(
			"config: DOCGEN_JWT_SECRET must be set and at least %d bytes long",
			MinJWTSecretLength,
		)
	}
	return cfg, nil
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
		return 0, fmt.Errorf("config: %s: %w", key, errors.New("must be positive"))
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
		return 0, fmt.Errorf("config: %s: %w", key, errors.New("must be positive"))
	}
	return n, nil
}
