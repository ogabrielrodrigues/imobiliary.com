// Package config loads runtime settings from the environment.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

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
	// WritePerUser bounds the expensive authenticated operations: uploading a
	// template and rendering a document.
	WritePerUser Rule
}

// Config is the fully resolved configuration of the service.
type Config struct {
	Addr         string
	DatabasePath string
	BlobDir      string
	// IdentityPublicKeys are the Imobiliary platform's token verification
	// keys, "name:base64,name:base64" as `imobiliary public-keys` prints them.
	// Identity lives there (PLANO-FASE-7.md §4); this service holds no secret.
	IdentityPublicKeys string
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
// everything except the platform's public keys, which have no safe default.
func Load() (*Config, error) {
	cfg := &Config{
		// Loopback by default. The API is meant to be reachable only by the
		// platform, and with DOCGEN_TRUST_PROXY_HEADERS on, anyone who can reach
		// it directly can forge X-Forwarded-For. Exposing it takes a decision.
		Addr:               env("DOCGEN_ADDR", "127.0.0.1:8080"),
		DatabasePath:       env("DOCGEN_DB_PATH", "data/docgen.db"),
		BlobDir:            env("DOCGEN_BLOB_DIR", "data/blobs"),
		IdentityPublicKeys: os.Getenv("DOCGEN_IDENTITY_PUBLIC_KEYS"),
		TrustProxyHeaders:  envBool("DOCGEN_TRUST_PROXY_HEADERS", false),
		ShutdownTimeout:    15 * time.Second,
		RateLimits: RateLimits{
			GlobalPerIP:  Rule{Rate: 10, Burst: 60},
			WritePerUser: Rule{Rate: 2, Burst: 20},
		},
	}

	var err error
	if cfg.MaxTemplateBytes, err = envInt64("DOCGEN_MAX_TEMPLATE_BYTES", 10<<20); err != nil {
		return nil, err
	}
	if cfg.MaxRequestBytes, err = envInt64("DOCGEN_MAX_REQUEST_BYTES", 1<<20); err != nil {
		return nil, err
	}

	if strings.TrimSpace(cfg.IdentityPublicKeys) == "" {
		return nil, errors.New("config: DOCGEN_IDENTITY_PUBLIC_KEYS must be set " +
			"(run `imobiliary public-keys` on the platform to print them)")
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
