package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A34: chi's RealIP overwrites RemoteAddr from caller-controlled headers
// (True-Client-IP, X-Real-IP, leftmost X-Forwarded-For), letting clients
// spoof their IP and evade rate limits. chi v5.3 adds ClientIPFrom*/GetClientIP
// helpers with the same risk. The client IP comes only from internal/clientip
// (mw.ClientIP); no backend code may use chi's client-IP middleware.
func TestServerDoesNotUseChiRealIP(t *testing.T) {
	banned := []string{".RealIP", ".ClientIPFrom", ".GetClientIP"}
	root := filepath.Join("..", "..")
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		scanned++
		for _, b := range banned {
			if strings.Contains(string(src), b) {
				t.Errorf("%s references %s: forbidden (audit A34, spoofable client IP); use mw.ClientIP", path, b)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned == 0 || !strings.Contains(mustRead(t, "server.go"), "mw.ClientIP") {
		t.Fatal("guard scanned nothing or server.go no longer wires mw.ClientIP")
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
