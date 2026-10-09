package server

import (
	"os"
	"strings"
	"testing"
)

// A34: chi's RealIP overwrites RemoteAddr from caller-controlled headers
// (True-Client-IP, X-Real-IP, leftmost X-Forwarded-For), letting clients
// spoof their IP and evade rate limits. Use mw.ClientIP instead.
func TestServerDoesNotUseChiRealIP(t *testing.T) {
	src, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"chimw.RealIP", "middleware.RealIP"} {
		if strings.Contains(string(src), banned) {
			t.Fatalf("server.go references %s: forbidden (audit A34, spoofable client IP); use mw.ClientIP", banned)
		}
	}
}
