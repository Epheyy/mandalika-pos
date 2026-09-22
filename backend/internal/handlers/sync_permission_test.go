package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

func TestSyncBatchAuthenticatedMapping(t *testing.T) {
	// Synthetic signing material only. No configuration loading or DB connection.
	secret := []byte("S0B-SYNTHETIC-TEST-KEY-NOT-A-PRODUCTION-SECRET")
	issue := func(role string, perms []string, ttl time.Duration) string {
		t.Helper()
		token, err := auth.IssueAccess(secret, ttl, "real-cashier", role, "outlet-a", perms)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	// The old valid token deliberately keeps its permission after a new token
	// for the same identity is issued without it. No live revocation is implied.
	oldToken := issue("cashier", []string{"process_refund"}, time.Hour)
	refreshedToken := issue("cashier", nil, time.Hour)
	for _, tc := range []struct {
		name, token, outlet string
		status              int
		allowed             bool
		wantOutlet          string
	}{
		{"old valid permission snapshot", oldToken, "", 200, true, "outlet-a"},
		{"refreshed without permission", refreshedToken, "", 200, false, "outlet-a"},
		{"same outlet header", oldToken, "outlet-a", 200, true, "outlet-a"},
		{"cashier cannot select another outlet", oldToken, "outlet-b", 403, false, ""},
		{"technical admin active outlet", issue("admin", nil, time.Hour), "outlet-b", 200, true, "outlet-b"},
		{"TL needs permission", issue("tl", nil, time.Hour), "", 200, false, "outlet-a"},
		{"missing token", "", "", 401, false, ""},
		{"invalid token", "invalid.synthetic.token", "", 401, false, ""},
		{"expired token", issue("cashier", []string{"process_refund"}, -time.Hour), "", 401, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, resolutions := 0, 0
			h := &Handlers{}
			wrapped := mw.RequireAuth(&config.Config{AccessSecret: secret})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				h.syncBatch(w, r, func(r *http.Request) (callerID, error) {
					// Only Store.ByID enrichment is replaced; the real HTTP body
					// decoder, capability mapping and authentication middleware run.
					resolutions++
					uid, _ := r.Context().Value(auth.CtxUserID).(string)
					outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
					return callerID{userID: uid, outletID: outlet, name: "Synthetic Cashier"}, nil
				}, func(_ context.Context, c syncpkg.Caller, items []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
					calls++
					if c.CanRefund != tc.allowed || c.UserID != "real-cashier" || c.OutletID != tc.wantOutlet || c.DisplayName != "Synthetic Cashier" {
						t.Fatalf("trusted mapping=%+v", c)
					}
					if len(items) != 1 || items[0].Type != "refund" || items[0].IdempotencyKey != "original-key" || !strings.Contains(string(items[0].Payload), "alreadyPaid") {
						t.Fatalf("items=%+v", items)
					}
					// This test captures trusted arguments. Dispatch behavior is
					// independently tested at the actual refund invocation boundary.
					return syncpkg.BatchResult{Results: []syncpkg.ItemResult{}}, nil
				})
			}))
			body := `{"role":"admin","permissions":["process_refund"],"CanRefund":true,"outletId":"forged","items":[{"type":"refund","idempotencyKey":"original-key","CanRefund":true,"payload":{"orderId":"original-order","role":"admin","permissions":["process_refund"],"alreadyPaid":true,"approvedBy":"historical-spv","clientCreatedAt":"2020-01-01","outletId":"forged"}}]}`
			req := httptest.NewRequest(http.MethodPost, "/sync/batch", strings.NewReader(body))
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			if tc.outlet != "" {
				req.Header.Set("X-Outlet-Id", tc.outlet)
			}
			w := httptest.NewRecorder()
			wrapped.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			wantCalls := 0
			if tc.status == 200 {
				wantCalls = 1
				var decoded map[string]json.RawMessage
				if err := json.Unmarshal(w.Body.Bytes(), &decoded); err != nil || decoded["data"] == nil {
					t.Fatalf("envelope=%s err=%v", w.Body.String(), err)
				}
			}
			if calls != wantCalls || resolutions != wantCalls {
				t.Fatalf("calls=%d resolutions=%d", calls, resolutions)
			}
			// Compare the existing direct middleware with this exact token/scope.
			directCalls := 0
			direct := mw.RequireAuth(&config.Config{AccessSecret: secret})(mw.RequirePermission("process_refund")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { directCalls++; w.WriteHeader(204) })))
			dw := httptest.NewRecorder()
			direct.ServeHTTP(dw, req.Clone(context.Background()))
			wantStatus, wantDirect := tc.status, 0
			if tc.status == 200 {
				wantStatus = 403
				if tc.allowed {
					wantStatus, wantDirect = 204, 1
				}
			}
			if dw.Code != wantStatus || directCalls != wantDirect {
				t.Fatalf("direct status=%d calls=%d", dw.Code, directCalls)
			}
		})
	}
}

func TestSyncBatchEmptyActiveOutletStillDenied(t *testing.T) {
	h := &Handlers{}
	w := httptest.NewRecorder()
	h.syncBatch(w, httptest.NewRequest(http.MethodPost, "/sync/batch", strings.NewReader(`{"items":[]}`)),
		func(*http.Request) (callerID, error) { return callerID{}, nil },
		func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
			t.Fatal("empty scope reached dispatch")
			return syncpkg.BatchResult{}, nil
		})
	if w.Code != 403 {
		t.Fatalf("status=%d", w.Code)
	}
}
