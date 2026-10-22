package middleware

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/httpx"
)

// BodyLimit caps every request body. limitFor must return a positive limit for
// every request (no route is exempt). A declared Content-Length over the limit
// is refused with 413 without reading the body; otherwise the body is wrapped in
// http.MaxBytesReader, which also bounds chunked bodies (ContentLength -1) and
// surfaces *http.MaxBytesError to the handler's decoder.
func BodyLimit(limitFor func(*http.Request) int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			limit := limitFor(r)
			if r.ContentLength > limit {
				httpx.Err(w, http.StatusRequestEntityTooLarge, "request body too large")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			next.ServeHTTP(w, r)
		})
	}
}
