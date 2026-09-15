package config

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func key(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func setValid(t *testing.T) {
	t.Setenv("IMOBILIARY_DATABASE_URL", "postgres://imobiliary_app@localhost/imobiliary")
	t.Setenv("IMOBILIARY_FIELD_KEYS", "1:"+key(t))
	t.Setenv("IMOBILIARY_INDEX_KEY", key(t))
}

func TestLoadServerDefaults(t *testing.T) {
	setValid(t)
	cfg, err := LoadServer()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:8081" || cfg.MetricsAddr != "127.0.0.1:9181" {
		t.Errorf("listeners default to %s and %s, want loopback", cfg.Addr, cfg.MetricsAddr)
	}
	if cfg.TrustProxyHeaders {
		t.Error("proxy headers are trusted by default")
	}
	if len(cfg.FieldKeys) != 1 || len(cfg.IndexKey) != 32 {
		t.Error("keys were not loaded")
	}
}

func TestLoadServerFailsClosed(t *testing.T) {
	cases := map[string]func(t *testing.T){
		"no database":      func(t *testing.T) { t.Setenv("IMOBILIARY_DATABASE_URL", "") },
		"no field keys":    func(t *testing.T) { t.Setenv("IMOBILIARY_FIELD_KEYS", "") },
		"short field key":  func(t *testing.T) { t.Setenv("IMOBILIARY_FIELD_KEYS", "1:c2hvcnQ=") },
		"no index key":     func(t *testing.T) { t.Setenv("IMOBILIARY_INDEX_KEY", "") },
		"shared listener":  func(t *testing.T) { t.Setenv("IMOBILIARY_METRICS_ADDR", "127.0.0.1:8081") },
		"zero shutdown":    func(t *testing.T) { t.Setenv("IMOBILIARY_SHUTDOWN_TIMEOUT", "0s") },
		"bad request size": func(t *testing.T) { t.Setenv("IMOBILIARY_MAX_REQUEST_BYTES", "lots") },
	}
	for name, breakIt := range cases {
		t.Run(name, func(t *testing.T) {
			setValid(t)
			breakIt(t)
			if _, err := LoadServer(); err == nil {
				t.Fatal("LoadServer accepted an unsafe configuration")
			}
		})
	}
}

func TestLoadMigratorNeedsItsOwnURL(t *testing.T) {
	t.Setenv("IMOBILIARY_MIGRATION_DATABASE_URL", "")
	if _, err := LoadMigrator(); err == nil {
		t.Fatal("LoadMigrator started without a database URL")
	}
}

func TestLoadDotEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	content := strings.Join([]string{
		"# a comment",
		"",
		"IMOBILIARY_TEST_PLAIN=plain",
		`IMOBILIARY_TEST_QUOTED="with spaces"`,
		"IMOBILIARY_TEST_URL=postgres://u@h/db?sslmode=disable",
		"IMOBILIARY_TEST_ALREADY=from-file",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"IMOBILIARY_TEST_PLAIN", "IMOBILIARY_TEST_QUOTED", "IMOBILIARY_TEST_URL"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	t.Setenv("IMOBILIARY_TEST_ALREADY", "from-environment")

	if err := LoadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"IMOBILIARY_TEST_PLAIN":   "plain",
		"IMOBILIARY_TEST_QUOTED":  "with spaces",
		"IMOBILIARY_TEST_URL":     "postgres://u@h/db?sslmode=disable",
		"IMOBILIARY_TEST_ALREADY": "from-environment",
	} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}

	if err := LoadDotEnv(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Errorf("a missing file is an error: %v", err)
	}
	bad := filepath.Join(t.TempDir(), "bad")
	os.WriteFile(bad, []byte("NOT A PAIR"), 0o600)
	if err := LoadDotEnv(bad); err == nil {
		t.Error("a malformed line was accepted")
	}
}
