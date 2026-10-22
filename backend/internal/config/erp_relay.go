package config

import (
	"errors"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// ERPRelay is the configuration of the erp_outbox relay (plan step 5).
// BaseURL/APIKey/SchedulerToken are copied from Config (ERP_BASE_URL, ERP_API_KEY,
// ERP_SCHEDULER_TOKEN), so the keys are read in one place.
type ERPRelay struct {
	Enabled        bool
	BaseURL        string // includes /api/integration/v1
	APIKey         string
	Brand          string
	SchedulerToken string // shared secret of POST /api/v1/internal/erp/relay (D15)
	MaxAttempts    int

	maxAttemptsBad bool
}

const (
	defaultERPMaxAttempts = 10
	maxERPMaxAttempts     = 100
	minSchedulerTokenLen  = 32
)

var erpBrandRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// LoadERPRelay copies ERPBaseURL, ERPAPIKey and ERPSchedulerToken from c (already
// trimmed by Load) and reads ERP_RELAY_ENABLED, ERP_BRAND (default "mandalika") and
// ERP_RELAY_MAX_ATTEMPTS (default 10, 1..100) from the environment. A bad max-attempts
// value is reported by Validate, never by a panic.
func LoadERPRelay(c *Config) ERPRelay { return LoadERPRelayFrom(c, os.Getenv) }

// LoadERPRelayFrom is LoadERPRelay with an injectable environment lookup.
func LoadERPRelayFrom(c *Config, getenv func(string) string) ERPRelay {
	e := ERPRelay{
		Enabled:        envERPOn(getenv("ERP_RELAY_ENABLED")),
		BaseURL:        c.ERPBaseURL,
		APIKey:         c.ERPAPIKey,
		SchedulerToken: c.ERPSchedulerToken,
		Brand:          strings.TrimSpace(getenv("ERP_BRAND")),
		MaxAttempts:    defaultERPMaxAttempts,
	}
	if e.Brand == "" {
		e.Brand = "mandalika"
	}
	if raw := strings.TrimSpace(getenv("ERP_RELAY_MAX_ATTEMPTS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxERPMaxAttempts {
			e.maxAttemptsBad = true
		} else {
			e.MaxAttempts = n
		}
	}
	return e
}

func envERPOn(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return v == "true" || v == "1"
}

// hasBadSecretChar reports a space or control character inside a key or token.
func hasBadSecretChar(v string) bool {
	return strings.IndexFunc(v, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Validate never includes a configured value in its error text. prod is the server's
// production flag (ENV=production); it requires https for non-loopback hosts.
func (e ERPRelay) Validate(prod bool) error {
	if e.maxAttemptsBad {
		return errors.New("ERP_RELAY_MAX_ATTEMPTS must be an integer from 1 to 100")
	}
	if e.SchedulerToken != "" && len(e.SchedulerToken) < minSchedulerTokenLen {
		return errors.New("ERP_SCHEDULER_TOKEN must be at least 32 characters")
	}
	if hasBadSecretChar(e.SchedulerToken) {
		return errors.New("ERP_SCHEDULER_TOKEN must not contain spaces or control characters")
	}
	if hasBadSecretChar(e.APIKey) {
		return errors.New("ERP_API_KEY must not contain spaces or control characters")
	}
	if !e.Enabled {
		return nil
	}
	u, err := url.Parse(e.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" {
		return errors.New("ERP_BASE_URL must be an absolute http(s) URL with a host and no query")
	}
	if u.User != nil {
		return errors.New("ERP_BASE_URL must not contain credentials")
	}
	if prod && u.Scheme != "https" && !isLoopbackHost(u.Hostname()) {
		return errors.New("ERP_BASE_URL must use https in production")
	}
	if e.APIKey == "" {
		return errors.New("ERP_API_KEY is required when ERP_RELAY_ENABLED is on")
	}
	if !erpBrandRE.MatchString(e.Brand) {
		return errors.New("ERP_BRAND must match ^[a-z0-9][a-z0-9-]{0,39}$")
	}
	return nil
}
