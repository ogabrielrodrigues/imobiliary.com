package config

import (
	"strings"
	"testing"
)

// The service verifies the platform's tokens and signs nothing, so the one
// setting without a default is the platform's public keys.
func TestLoadRequiresThePlatformsPublicKeys(t *testing.T) {
	t.Setenv("DOCGEN_IDENTITY_PUBLIC_KEYS", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "DOCGEN_IDENTITY_PUBLIC_KEYS") {
		t.Errorf("Load without keys = %v", err)
	}

	t.Setenv("DOCGEN_IDENTITY_PUBLIC_KEYS", "1:AAAA")
	cfg, err := Load()
	if err != nil || cfg.IdentityPublicKeys != "1:AAAA" {
		t.Errorf("Load with keys = %+v, %v", cfg, err)
	}
}
