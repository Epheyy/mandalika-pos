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
	return RateLimitWith(c, prefix, max, window, jsonLimited)
}

// jsonLimited is the API refusal body: 429 with the JSON error envelope.
func jsonLimited(w http.ResponseWriter, _ *http.Request) {
	httpx.Err(w, http.StatusTooManyRequests, "rate limit exceeded")
}

// RateLimitWith is RateLimit with its own refusal writer (the public HTML pages answer in HTML).
// Counting and the Retry-After header are identical; limited must write the 429 status and body.
func RateLimitWith(c *cache.Cache, prefix string, max int, window time.Duration, limited func(http.ResponseWriter, *http.Request)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientip.ClientIPBucket(r)
			now := time.Now()
			bucket := now.Unix() / int64(window.Seconds())
			key := "rl:" + prefix + ":" + ip + ":" + strconv.FormatInt(bucket, 10)

			if c.IncrWindow(r.Context(), key, window) > int64(max) {
				w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds(now, window)))
				limited(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// retryAfterSeconds is the time left in the current fixed window (bucket end - now),
// rounded up and never below 1, so a client told to wait that long lands in a fresh bucket.
func retryAfterSeconds(now time.Time, window time.Duration) int {
	w := int64(window.Seconds())
	left := w - now.Unix()%w
	if left < 1 {
		left = 1
	}
	return int(left)
}
