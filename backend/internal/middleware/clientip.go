package middleware

import (
	"log/slog"
	"net/http"

	"github.com/mandalika/pos-backend/internal/clientip"
)

// ClientIP resolves the client address once per request and stores it in the
// request context (read via clientip.ClientIP / ClientIPBucket). It replaces
// chi's RealIP, which trusts caller-controlled headers. r.RemoteAddr is left
// untouched. `hops` is the number of trusted proxies appending to
// X-Forwarded-For; 0 means use the TCP peer only.
func ClientIP(hops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			res := clientip.Extract(r.RemoteAddr, r.Header.Values("X-Forwarded-For"), hops)
			switch res.Reason {
			case clientip.ReasonNone:
			case clientip.ReasonNoXFF:
				slog.Debug("client_ip_fallback", "reason", res.Reason)
			default:
				slog.Warn("client_ip_fallback", "reason", res.Reason)
			}
			next.ServeHTTP(w, r.WithContext(clientip.WithAddr(r.Context(), res.Addr)))
		})
	}
}
