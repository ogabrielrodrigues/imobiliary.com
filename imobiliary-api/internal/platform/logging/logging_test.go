package logging

import (
	"bytes"
	json "encoding/json/v2"
	"log/slog"
	"strings"
	"testing"
)

func TestSensitiveAttributesAreRedacted(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf, slog.LevelInfo)

	logger.Info("sign-in",
		slog.String("email", "ana@example.com"),
		slog.String("refresh_token", "abc"),
		slog.Group("person", slog.String("identity", "52998224725"), slog.String("name", "Ana")),
		slog.String("Authorization", "Bearer xyz"),
		slog.String("route", "POST /v1/sessions"),
		slog.Int("status", 201),
	)

	line := buf.String()
	for _, leaked := range []string{"ana@example.com", "abc", "52998224725", "xyz"} {
		if strings.Contains(line, leaked) {
			t.Errorf("log line contains %q: %s", leaked, line)
		}
	}

	var record map[string]any
	if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
		t.Fatalf("log line is not JSON: %v", err)
	}
	if record["route"] != "POST /v1/sessions" || record["msg"] != "sign-in" {
		t.Errorf("ordinary attributes were altered: %v", record)
	}
	if person, _ := record["person"].(map[string]any); person["name"] != "Ana" || person["identity"] != Redacted {
		t.Errorf("grouped attributes were handled wrongly: %v", person)
	}
}

func TestParseLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "WARN": slog.LevelWarn, "": slog.LevelInfo, "loud": slog.LevelInfo} {
		if got := ParseLevel(in); got != want {
			t.Errorf("ParseLevel(%q) = %v, want %v", in, got, want)
		}
	}
}
