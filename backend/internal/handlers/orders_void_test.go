package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/write"
)

func voidRequest(t *testing.T, h *Handlers, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	r.Post("/orders/{id}/void", h.VoidOrder)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/orders/0f8fad5b-d9cb-469f-a165-70867728950e/void", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestVoidOrderHandlerRequiresClientUuid(t *testing.T) {
	h := &Handlers{}
	for name, body := range map[string]string{
		"missing":       `{"reasonCode":"salah_barang","mode":"none"}`,
		"not canonical": `{"reasonCode":"salah_barang","mode":"none","clientVoidUuid":"nope"}`,
	} {
		w := voidRequest(t, h, body)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "clientVoidUuid tidak valid.") {
			t.Fatalf("%s: status %d body %s, want 400 clientVoidUuid tidak valid.", name, w.Code, w.Body.String())
		}
	}
}

func TestVoidOrderHandlerNeedsVoidAny(t *testing.T) {
	calls := 0
	guarded := mw.RequirePermission("void_any")(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	for name, perms := range map[string][]string{
		"cashier with only void_own_shift": {"void_own_shift"},
		"manager with refund only":         {"process_refund"},
	} {
		ctx := context.WithValue(context.Background(), auth.CtxRole, "cashier")
		ctx = context.WithValue(ctx, auth.CtxPerms, perms)
		w := httptest.NewRecorder()
		guarded.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/orders/x/void", nil).WithContext(ctx))
		if w.Code != http.StatusForbidden || calls != 0 {
			t.Fatalf("%s: status %d calls %d, want 403 before the handler", name, w.Code, calls)
		}
	}
	ctx := context.WithValue(context.Background(), auth.CtxRole, "cashier")
	ctx = context.WithValue(ctx, auth.CtxPerms, []string{"void_any"})
	guarded.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/orders/x/void", nil).WithContext(ctx))
	if calls != 1 {
		t.Fatalf("void_any holder did not reach the handler (calls=%d)", calls)
	}
}

func TestSettingsVoidWindowBounds(t *testing.T) {
	var repo *write.Repo // the bounds are checked before any database access
	for _, days := range []int{0, 31, -1} {
		raw, _ := json.Marshal(map[string]any{"voidWindowDays": days})
		err := repo.UpdateAppSettingsBy(context.Background(), "", raw)
		if err == nil || !strings.Contains(err.Error(), "Batas waktu pembatalan harus 1–30 hari.") {
			t.Fatalf("voidWindowDays %d: err = %v, want the bounds message", days, err)
		}
	}
}
