package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
)

type fakeRevocation struct {
	v        int64
	exists   bool
	err      error
	observed []int64
}

func (f *fakeRevocation) Current(context.Context, string) (int64, bool, error) {
	return f.v, f.exists, f.err
}
func (f *fakeRevocation) Observe(_ string, pv int64) { f.observed = append(f.observed, pv) }

func revCfg() *config.Config {
	return &config.Config{AccessSecret: []byte(strings.Repeat("a", 48))}
}

func revCall(t *testing.T, mwf func(http.Handler) http.Handler, role, outlet string, pv int64, outletHdr string) *httptest.ResponseRecorder {
	t.Helper()
	tok, err := auth.IssueAccessV(revCfg().AccessSecret, time.Minute, "u1", role, outlet, nil, pv)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if outletHdr != "" {
		req.Header.Set("X-Outlet-Id", outletHdr)
	}
	rec := httptest.NewRecorder()
	mwf(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })).ServeHTTP(rec, req)
	return rec
}

func errBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var b struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	return b.Error
}

func TestRequireAuthStalePVIs401(t *testing.T) {
	f := &fakeRevocation{v: 4, exists: true}
	rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "", 3, "")
	if rec.Code != 401 || errBody(t, rec) != "token revoked" {
		t.Fatalf("status %d err %q body=%s", rec.Code, errBody(t, rec), rec.Body)
	}
}

func TestRequireAuthCurrentPVPasses(t *testing.T) {
	f := &fakeRevocation{v: 4, exists: true}
	if rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "", 4, ""); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestRequireAuthNewerTokenPasses(t *testing.T) {
	f := &fakeRevocation{v: 4, exists: true}
	if rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "", 5, ""); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if len(f.observed) != 1 || f.observed[0] != 5 {
		t.Fatalf("observed %v, want [5]", f.observed)
	}
}

func TestRequireAuthDeletedUserIs401(t *testing.T) {
	f := &fakeRevocation{exists: false}
	if rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "", 0, ""); rec.Code != 401 {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestRequireAuthNoVerdictIs503(t *testing.T) {
	f := &fakeRevocation{err: errors.New("db down")}
	rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "", 0, "")
	if rec.Code != 503 || rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("status %d retry-after %q, want 503 / 2", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestRequireAuthRevokedBeforeOutletCheck(t *testing.T) {
	f := &fakeRevocation{v: 2, exists: true}
	rec := revCall(t, RequireAuth(revCfg(), WithRevocation(f)), "cashier", "outlet-new", 1, "outlet-old")
	if rec.Code != 401 {
		t.Fatalf("status %d, want 401 (a 403 would never refresh)", rec.Code)
	}
}

func TestRequireAuthWithoutCheckerUnchanged(t *testing.T) {
	if rec := revCall(t, RequireAuth(revCfg()), "cashier", "", 0, ""); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
}
