// Package logging builds the service's operational logger.
//
// Operational logs are one JSON object per line on stdout. The Datadog Agent
// and Grafana Alloy both collect that form as it is, so no vendor SDK is
// linked into the service and switching platforms touches no code.
//
// These logs are not the audit trail, which lives in the database next to the
// data it describes, and they must never carry personal data: the redaction
// below is the last line of defence, not a licence to log carelessly.
package logging

import (
	"io"
	"log/slog"
	"strings"
)

// Redacted replaces the value of any attribute whose key names sensitive data.
const Redacted = "[redacted]"

// sensitiveKeys are matched against the last segment of an attribute key,
// case-insensitively. A key containing any of these words is redacted:
// "refresh_token", "user_email" and "identity" all are.
var sensitiveKeys = []string{
	"password", "secret", "token", "authorization", "cookie",
	"email", "phone", "identity", "registration", "cpf", "cnpj",
	"birth", "key",
}

// New returns a JSON logger writing to w at the given level.
func New(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: redact,
	}))
}

// ParseLevel reads a level name, falling back to info.
func ParseLevel(name string) slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(name)); err != nil {
		return slog.LevelInfo
	}
	return level
}

func redact(groups []string, a slog.Attr) slog.Attr {
	// The built-in keys (time, level, msg, source) are never sensitive.
	if len(groups) == 0 {
		switch a.Key {
		case slog.TimeKey, slog.LevelKey, slog.MessageKey, slog.SourceKey:
			return a
		}
	}
	if IsSensitive(a.Key) {
		return slog.String(a.Key, Redacted)
	}
	return a
}

// IsSensitive reports whether an attribute key names data that must not be
// logged.
func IsSensitive(key string) bool {
	key = strings.ToLower(key)
	for _, word := range sensitiveKeys {
		if strings.Contains(key, word) {
			return true
		}
	}
	return false
}
