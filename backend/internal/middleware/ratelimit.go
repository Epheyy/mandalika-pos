package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// RateLimit is a fixed-window per-IP limiter. Counters live in Redis (shared
// across instances) and fall back to a bounded per-instance in-memory window
// when Redis is disabled, down or behind an open breaker, so limits (notably on
// /auth/login) survive a Redis outage. With several instances the effective
// limit can be up to N times higher during an outage. `max` requests are
// allowed per `window`.
func RateLimit(c *cache.Cache, prefix string, max int, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientip.ClientIPBucket(r)
			bucket := time.Now().Unix() / int64(window.Seconds())
			key := "rl:" + prefix + ":" + ip + ":" + strconv.FormatInt(bucket, 10)

			if c.IncrWindow(r.Context(), key, window) > int64(max) {
				w.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
				httpx.Err(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
