package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
)

func TestRequireCatalogueWide(t *testing.T) {
	const denied = "Hanya admin atau Manajer Semua Outlet yang dapat mengubah katalog."
	cases := []struct {
		name string
		role string
		cov  coverage.Coverage
		want int
	}{
		{"admin", "admin", coverage.Coverage{}, 200},
		{"manager all outlets", "manager", coverage.Coverage{All: true}, 200},
		{"manager covering some outlets", "manager", coverage.Coverage{OutletIDs: []string{"a"}}, 403},
		{"manager covering nothing", "manager", coverage.Coverage{}, 403},
		{"cashier with a forged All coverage", "cashier", coverage.Coverage{All: true}, 403},
		{"no role", "", coverage.Coverage{All: true}, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := RequireCatalogueWide()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			ctx := context.WithValue(context.Background(), auth.CtxCoverage, tc.cov)
			if tc.role != "" {
				ctx = context.WithValue(ctx, auth.CtxRole, tc.role)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("PUT", "/products/x", nil).WithContext(ctx))
			if w.Code != tc.want {
				t.Fatalf("code = %d, want %d", w.Code, tc.want)
			}
			if tc.want == 403 {
				var out struct {
					Error string `json:"error"`
				}
				_ = json.Unmarshal(w.Body.Bytes(), &out)
				if out.Error != denied {
					t.Fatalf("error = %q, want %q", out.Error, denied)
				}
			}
		})
	}
}
