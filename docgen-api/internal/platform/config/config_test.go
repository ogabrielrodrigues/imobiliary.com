package config

import (
	"strings"
	"testing"
)

// validSecret satisfies the JWT secret rule so each case isolates the mail one.
const validSecret = "0123456789abcdef0123456789abcdef"

// TestLoadRefusesToStartWithoutAWayToSendMail covers the rule that keeps the
// log fallback from being chosen by accident. That fallback prints
// password-reset links, so a deployment that simply forgot the provider key has
// to fail at boot rather than serve every reset link to whoever reads its logs.
func TestLoadRefusesToStartWithoutAWayToSendMail(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		mailLog string
		wantErr bool
	}{
		{name: "neither is refused", key: "", mailLog: "", wantErr: true},
		{name: "a provider key is enough", key: "re_test_key", mailLog: "", wantErr: false},
		{name: "logging must be asked for by name", key: "", mailLog: "true", wantErr: false},
		{name: "a false flag is not a declaration", key: "", mailLog: "false", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DOCGEN_JWT_SECRET", validSecret)
			t.Setenv("DOCGEN_RESEND_API_KEY", tc.key)
			t.Setenv("DOCGEN_MAIL_LOG", tc.mailLog)

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatal("Load succeeded; want it to refuse to start")
				}
				if !strings.Contains(err.Error(), "DOCGEN_MAIL_LOG") {
					t.Errorf("error %q does not name the way out", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg == nil {
				t.Fatal("Load returned no config")
			}
		})
	}
}
