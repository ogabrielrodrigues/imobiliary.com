// Package mail sends the few messages this service has to send.
//
// There are exactly two: the link that authorises a password reset, and the
// notice that a password has changed. Both exist because a password reset needs
// a channel outside the platform — otherwise anyone who lost their password
// would have lost the account with it.
//
// Two adapters. Resend, for deployments that need a message to actually arrive,
// and a logging one that writes the message to stdout and is the default when
// no key is configured — so development never sends anything to anybody, and
// the reset link shows up in the terminal where it is wanted.
package mail

import (
	"bytes"
	"context"
	json "encoding/json/v2"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// Bodies are plain text throughout. Nothing this service sends needs markup,
// and plain text cannot carry a tracking pixel or a remote image.

// Logger writes messages to a log instead of sending them.
//
// The default, and the right behaviour in development: a reset link printed in
// the terminal is more useful than one delivered to a real inbox, and nothing
// can reach a real person by accident.
type Logger struct {
	logger *slog.Logger
}

// NewLogger returns a mailer that only logs.
func NewLogger(logger *slog.Logger) *Logger {
	if logger == nil {
		logger = slog.Default()
	}
	return &Logger{logger: logger}
}

// Send records the message.
func (l *Logger) Send(_ context.Context, to, subject, body string) error {
	l.logger.Info("email not sent (no mail provider configured)",
		slog.String("to", to),
		slog.String("subject", subject),
		slog.String("body", body),
	)
	return nil
}

// resendEndpoint is the only URL this package talks to.
const resendEndpoint = "https://api.resend.com/emails"

// resendTimeout bounds one delivery attempt. A password reset that hangs is
// worse than one that fails: the caller is waiting on it.
const resendTimeout = 10 * time.Second

// Resend delivers through the Resend API.
//
// Written against the HTTP API rather than the official SDK on purpose. The
// payload is four fields, so the SDK would buy nothing and would be the
// module's fourth dependency; net/http is enough, and swapping to another
// provider later is a file like this one and nothing else.
type Resend struct {
	apiKey string
	from   string
	client *http.Client
}

// NewResend returns a mailer that posts to Resend. from must be an address on a
// domain verified with them, or every message is refused.
func NewResend(apiKey, from string) *Resend {
	return &Resend{
		apiKey: apiKey,
		from:   from,
		client: &http.Client{Timeout: resendTimeout},
	}
}

// Send delivers one message.
func (r *Resend) Send(ctx context.Context, to, subject, body string) error {
	payload, err := json.Marshal(map[string]any{
		"from":    r.from,
		"to":      []string{to},
		"subject": subject,
		"text":    body,
	})
	if err != nil {
		return fmt.Errorf("mail: encode message: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendEndpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("mail: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("mail: send: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		// Bounded, because the provider decides how much it says and this ends
		// up in a log line. The recipient is not repeated here: the caller
		// already knows it, and a log is a poor place for an address.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("mail: send: provider answered %d: %s", resp.StatusCode, detail)
	}
	return nil
}
