package middleware

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// SchedulerSecretHeader carries the shared secret Cloud Scheduler sends to the internal
// ERP catalog-pull route (plan §4.4, decision D15; OIDC replaces it after the demo).
const SchedulerSecretHeader = "X-Scheduler-Secret"

// RequireSchedulerSecret guards a machine-to-machine route with cfg.ERPSchedulerToken.
// An empty token disables the route (503), so a deployment that never set the secret
// exposes nothing. A missing or wrong header is 401. Both values are hashed with SHA-256
// before the constant-time compare so the length of the real token is not leaked. Neither
// value is ever logged or echoed.
func RequireSchedulerSecret(cfg *config.Config) func(http.Handler) http.Handler {
	want := sha256.Sum256([]byte(cfg.ERPSchedulerToken))
	enabled := cfg.ERPSchedulerToken != ""
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !enabled {
				httpx.Err(w, http.StatusServiceUnavailable, "scheduler endpoint disabled")
				return
			}
			got := sha256.Sum256([]byte(r.Header.Get(SchedulerSecretHeader)))
			if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
				httpx.Err(w, http.StatusUnauthorized, "invalid scheduler secret")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
