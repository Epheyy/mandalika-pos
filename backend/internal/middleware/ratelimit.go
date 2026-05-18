package middleware

import (
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// RateLimit is a fixed-window per-IP limiter backed by Redis (atomic INCR +
// EXPIRE), so it works across multiple backend instances and on managed
// Redis (Upstash). `max` requests are allowed per `window`. On Redis error
// it fails open — availability of sales beats strict throttling for a POS.
func RateLimit(c *cache.Cache, prefix string, max int, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			ip := clientIP(r)
			bucket := time.Now().Unix() / int64(window.Seconds())
			key := "rl:" + prefix + ":" + ip + ":" + strconv.FormatInt(bucket, 10)

			n, err := c.R.Incr(ctx, key).Result()
			if err != nil {
				next.ServeHTTP(w, r) // fail open
				return
			}
			if n == 1 {
				c.R.Expire(ctx, key, window)
			}
			if n > int64(max) {
				w.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
				httpx.Err(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
