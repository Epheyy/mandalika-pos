package middleware

import (
	"context"
	"net/http"
	"time"
)

// Deadline gives every request a server-side context deadline. limitFor returns the
// budget for the request; 0 exempts it (the route manages its own, longer budget).
// It uses context.WithTimeout rather than http.TimeoutHandler on purpose: TimeoutHandler
// buffers the whole response and replaces the writer, which would break streaming and
// the per-route SetWriteDeadline calls. A handler that observes the expired context
// answers through the error classifier (503 + Retry-After for the server deadline).
func Deadline(limitFor func(*http.Request) time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			limit := limitFor(r)
			if limit <= 0 {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), limit)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
