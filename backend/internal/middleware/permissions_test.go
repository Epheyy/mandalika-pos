package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
)

func TestRequirePermissionPreservesOtherPermissionRules(t *testing.T) {
	for _, tc := range []struct {
		name, role, required string
		perms                []string
		allowed              bool
	}{
		{"refund allowed", "cashier", "process_refund", []string{"process_refund"}, true},
		{"refund denied", "cashier", "process_refund", []string{"create_order"}, false},
		{"other allowed", "cashier", "create_order", []string{"create_order"}, true},
		{"other denied", "cashier", "manage_stock", []string{"process_refund"}, false},
		{"admin bypass for other permission", "admin", "manage_stock", nil, true},
		{"empty context", "", "process_refund", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.WithValue(context.Background(), auth.CtxRole, tc.role)
			ctx = context.WithValue(ctx, auth.CtxPerms, tc.perms)
			calls := 0
			h := RequirePermission(tc.required)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(http.StatusNoContent) }))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/synthetic", nil).WithContext(ctx))
			if tc.allowed {
				if w.Code != http.StatusNoContent || calls != 1 {
					t.Fatalf("status=%d calls=%d", w.Code, calls)
				}
			} else if w.Code != http.StatusForbidden || calls != 0 || !strings.Contains(w.Body.String(), "missing permission: "+tc.required) {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
			}
		})
	}
}
