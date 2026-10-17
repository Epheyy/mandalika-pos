// Package observability wires structured logging and error tracking.
//
// Logging uses the stdlib log/slog (JSON in production, text in dev).
// Error tracking posts to Sentry's store endpoint using only the stdlib —
// no SDK dependency — and is a no-op when SENTRY_DSN is unset, so dev and
// CI need no Sentry account.
package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/redact"
)

// InitLogger installs a process-wide slog default. JSON in production so a
// log shipper can parse it; human-readable text in development.
func InitLogger(env string) *slog.Logger {
	level := slog.LevelInfo
	var h slog.Handler
	if strings.EqualFold(env, "production") {
		h = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	} else {
		h = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	}
	l := slog.New(h)
	slog.SetDefault(l)
	return l
}

// Sentry is a minimal, dependency-free error reporter. A nil/disabled Sentry
// is safe to call — every method becomes a no-op.
type Sentry struct {
	enabled    bool
	storeURL   string
	publicKey  string
	httpClient *http.Client
	env        string
	release    string
}

// NewSentry parses a standard Sentry DSN. An empty DSN yields a disabled
// reporter (no error — Sentry is optional).
func NewSentry(dsn, env, release string) (*Sentry, error) {
	if strings.TrimSpace(dsn) == "" {
		return &Sentry{enabled: false}, nil
	}
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse SENTRY_DSN: %w", err)
	}
	projectID := strings.Trim(u.Path, "/")
	if projectID == "" || u.User == nil {
		return nil, fmt.Errorf("malformed SENTRY_DSN")
	}
	store := fmt.Sprintf("%s://%s/api/%s/store/", u.Scheme, u.Host, projectID)
	return &Sentry{
		enabled:    true,
		storeURL:   store,
		publicKey:  u.User.Username(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
		env:        env,
		release:    release,
	}, nil
}

func (s *Sentry) Enabled() bool { return s != nil && s.enabled }

// CaptureError ships an exception event. Failures to deliver are logged and
// swallowed — telemetry must never break the request path.
func (s *Sentry) CaptureError(ctx context.Context, err error, tags map[string]string) {
	if !s.Enabled() || err == nil {
		return
	}
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)

	event := map[string]any{
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
		"level":       "error",
		"platform":    "go",
		"environment": s.env,
		"release":     s.release,
		"tags":        tags,
		// Same redactor as error_logs (A37): panic text can carry customer data or tokens.
		"message": redact.String(err.Error(), redact.Logs),
		"extra":   map[string]any{"stacktrace": redact.Stack(string(buf[:n]))},
	}
	body, mErr := json.Marshal(event)
	if mErr != nil {
		slog.Error("sentry marshal failed", "err", mErr)
		return
	}

	req, rErr := http.NewRequestWithContext(ctx, http.MethodPost, s.storeURL, bytes.NewReader(body))
	if rErr != nil {
		slog.Error("sentry request build failed", "err", rErr)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Sentry-Auth", fmt.Sprintf(
		"Sentry sentry_version=7, sentry_client=mandalika-stdlib/1.0, sentry_key=%s",
		s.publicKey))

	resp, dErr := s.httpClient.Do(req)
	if dErr != nil {
		slog.Error("sentry delivery failed", "err", dErr)
		return
	}
	_ = resp.Body.Close()
}
