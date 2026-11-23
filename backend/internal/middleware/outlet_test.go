package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
)

// outletCall sends one request through RequireAuth and returns the status and the
// active outlet the next handler saw.
func outletCall(t *testing.T, role, home string, cov coverage.Coverage, hdr, query string) (int, string) {
	t.Helper()
	tok, err := auth.IssueAccessCov(revCfg().AccessSecret, time.Minute, "u1", role, home, nil, 0, cov)
	if err != nil {
		t.Fatal(err)
	}
	target := "/x"
	if query != "" {
		target += "?" + query
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if hdr != "" {
		req.Header.Set("X-Outlet-Id", hdr)
	}
	rec := httptest.NewRecorder()
	var seen string
	RequireAuth(revCfg())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = r.Context().Value(auth.CtxOutletID).(string)
		w.WriteHeader(200)
	})).ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden && errBody(t, rec) != "outlet not permitted" {
		t.Fatalf("403 body = %q", errBody(t, rec))
	}
	return rec.Code, seen
}

func TestOutletActiveOutlet(t *testing.T) {
	ab := coverage.Coverage{OutletIDs: []string{"A", "B"}}
	onlyA := coverage.Coverage{OutletIDs: []string{"A"}}
	all := coverage.Coverage{All: true}
	cases := []struct {
		name       string
		role, home string
		cov        coverage.Coverage
		hdr, query string
		code       int
		wantOutlet string
	}{
		{"cashier no header", "cashier", "A", onlyA, "", "", 200, "A"},
		{"cashier own header", "cashier", "A", onlyA, "A", "", 200, "A"},
		{"cashier other header", "cashier", "A", onlyA, "B", "", 403, ""},
		{"manager no header", "manager", "A", ab, "", "", 200, "A"},
		{"manager covered header", "manager", "A", ab, "B", "", 200, "B"},
		{"manager uncovered header", "manager", "A", ab, "C", "", 403, ""},
		{"manager query all", "manager", "A", ab, "", "outletId=all", 403, ""},
		{"manager query uncovered", "manager", "A", ab, "", "outletId=C", 403, ""},
		{"manager query covered", "manager", "A", ab, "", "outletId=B", 200, "A"},
		{"manager all header", "manager", "", all, "C", "", 200, "C"},
		{"manager all no header", "manager", "", all, "", "", 200, ""},
		{"manager all query all", "manager", "", all, "", "outletId=all", 200, ""},
		{"legacy manager header", "manager", "", coverage.Coverage{}, "C", "", 403, ""},
		{"admin header", "admin", "", coverage.Coverage{}, "C", "", 200, "C"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, outlet := outletCall(t, c.role, c.home, c.cov, c.hdr, c.query)
			if code != c.code {
				t.Fatalf("status = %d, want %d", code, c.code)
			}
			if code == 200 && outlet != c.wantOutlet {
				t.Fatalf("outlet = %q, want %q", outlet, c.wantOutlet)
			}
		})
	}
}

func TestIssueAccessCovClaimsByRole(t *testing.T) {
	secret := revCfg().AccessSecret
	parse := func(role, home string, cov coverage.Coverage) *auth.Claims {
		tok, err := auth.IssueAccessCov(secret, time.Minute, "u1", role, home, nil, 0, cov)
		if err != nil {
			t.Fatal(err)
		}
		c, err := auth.ParseAccess(secret, tok)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	if c := parse("admin", "", coverage.Coverage{All: true}); c.AllOutlets || len(c.OutletIDs) != 0 {
		t.Fatal("admin must not carry coverage claims")
	}
	if c := parse("cashier", "A", coverage.Coverage{OutletIDs: []string{"A", "B"}}); len(c.OutletIDs) != 0 {
		t.Fatal("cashier must not carry ocv")
	}
	if c := parse("manager", "A", coverage.Coverage{OutletIDs: []string{"A"}}); len(c.OutletIDs) != 0 {
		t.Fatal("single-outlet manager must not carry ocv")
	}
	if c := parse("manager", "A", coverage.Coverage{OutletIDs: []string{"A", "B"}}); len(c.OutletIDs) != 2 {
		t.Fatal("two-outlet manager must carry ocv")
	}
	if c := parse("manager", "", coverage.Coverage{All: true}); !c.AllOutlets || !c.Coverage().All {
		t.Fatal("all-outlets manager must carry oall")
	}
}
