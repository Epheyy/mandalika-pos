package server

import (
	"net/http"
	"strings"

	chimw "github.com/go-chi/chi/v5/middleware"
)

// jsonCompressLevel is the gzip level for JSON responses, from BenchmarkCompressOrderPage (synthetic
// 1000-order page, 1.0 MB, Ryzen 5 5500U): level 1 ~20 ms (ratio 3.65), level 5 ~33 ms (ratio 4.67).
// A real 2.5 MB page is about 2.5x that (level 1 ~50 ms): level 5 is over the plan limit of 15 ms, so level 1.
const jsonCompressLevel = 1

// compressSkipPrefixes are never compressed: the OTA path is read by a native updater plugin
// that is not required to decode Content-Encoding, and auth answers are tiny token bodies.
var compressSkipPrefixes = []string{"/api/v1/ota/", "/api/v1/auth/"}

// compressJSON gzips (or deflates) application/json responses for clients that send
// Accept-Encoding, with chi's Compress. Other content types (the CSV exports) pass through
// untouched, Flush included. When it compresses, chi drops Content-Length and sets
// Content-Encoding and Vary: Accept-Encoding. Paths under compressSkipPrefixes bypass it.
func compressJSON(level int) func(http.Handler) http.Handler {
	compress := chimw.Compress(level, "application/json")
	return func(next http.Handler) http.Handler {
		compressed := compress(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for _, p := range compressSkipPrefixes {
				if strings.HasPrefix(r.URL.Path, p) {
					next.ServeHTTP(w, r)
					return
				}
			}
			compressed.ServeHTTP(w, r)
		})
	}
}
