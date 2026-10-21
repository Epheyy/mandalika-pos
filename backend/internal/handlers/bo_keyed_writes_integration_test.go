package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
)

// boKeyedWrites covers the optional Idempotency-Key on the three remaining backoffice
// writes (plan §3.1): points adjust, cash-flow create and discount-code batch. Run from
// TestOperationReceiptsPostgres. Each: the same key twice is one effect and a
// byte-identical answer, the same key with another body is a 409 that writes nothing,
// and no key behaves as before (a fresh effect each call, same status).
func boKeyedWrites(t *testing.T, ctx context.Context, pool *pgxpool.Pool, h *Handlers, secret []byte, token, outlet, shift string) {
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/cash-flows", h.CreateCashFlow)
	router.Post("/discount-codes/batch", h.CreateDiscountCodeBatch)
	router.Post("/customers/{id}/points/adjust", h.AdjustPoints)
	do := func(path, key, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	wantCode := func(w *httptest.ResponseRecorder, code int) {
		t.Helper()
		if w.Code != code {
			t.Fatalf("status %d, want %d: %s", w.Code, code, w.Body.String())
		}
	}

	t.Run("points-adjust", func(t *testing.T) {
		var cust string
		if err := pool.QueryRow(ctx, `INSERT INTO customers(name,phone,points) VALUES('BO pts','0800-bo-pts',10) RETURNING id`).Scan(&cust); err != nil {
			t.Fatal(err)
		}
		path := "/customers/" + cust + "/points/adjust"
		rows := func() int {
			return count(`SELECT count(*) FROM point_transactions WHERE customer_id=$1 AND type='adjust'`, cust)
		}
		first := do(path, "bo-pts-1", `{"points":5,"reason":"bonus"}`)
		wantCode(first, 200)
		if !strings.Contains(first.Body.String(), `"balanceAfter":15`) || rows() != 1 {
			t.Fatalf("first: %s rows=%d", first.Body.String(), rows())
		}
		again := do(path, "bo-pts-1", `{"points":5,"reason":"bonus"}`)
		wantCode(again, 200)
		if again.Body.String() != first.Body.String() || rows() != 1 || count(`SELECT points FROM customers WHERE id=$1`, cust) != 15 {
			t.Fatalf("replay: %s rows=%d", again.Body.String(), rows())
		}
		wantCode(do(path, "bo-pts-1", `{"points":6,"reason":"bonus"}`), 409)
		if rows() != 1 {
			t.Fatalf("conflict wrote: rows=%d", rows())
		}
		// No key: unchanged behaviour, a fresh effect per call and the same status codes.
		wantCode(do(path, "", `{"points":5,"reason":"x"}`), 200)
		wantCode(do(path, "", `{"points":5,"reason":"x"}`), 200)
		if rows() != 3 {
			t.Fatalf("unkeyed rows=%d, want 3", rows())
		}
		wantCode(do(path, "", `{"points":0,"reason":"x"}`), 400)
		wantCode(do(path, "bo-pts-bad", `{"points":-9999,"reason":"x"}`), 400)
		wantCode(do("/customers/00000000-0000-4000-8a00-0000000000ff/points/adjust", "bo-pts-404", `{"points":1,"reason":"x"}`), 404)
	})

	t.Run("cash-flow-create", func(t *testing.T) {
		body := `{"shiftId":"` + shift + `","type":"cash_in","amount":1500,"description":"bo keyed"}`
		rows := func() int { return count(`SELECT count(*) FROM cash_flows WHERE description='bo keyed'`) }
		first := do("/cash-flows", "bo-cf-1", body)
		wantCode(first, 201)
		again := do("/cash-flows", "bo-cf-1", body)
		wantCode(again, 201)
		if again.Body.String() != first.Body.String() || rows() != 1 || !strings.Contains(first.Body.String(), `"data":{"id":"`) {
			t.Fatalf("replay: %s vs %s rows=%d", again.Body.String(), first.Body.String(), rows())
		}
		wantCode(do("/cash-flows", "bo-cf-1", strings.Replace(body, "1500", "1600", 1)), 409)
		if rows() != 1 {
			t.Fatalf("conflict wrote: rows=%d", rows())
		}
		u1, u2 := do("/cash-flows", "", body), do("/cash-flows", "", body)
		wantCode(u1, 201)
		wantCode(u2, 201)
		if u1.Body.String() == u2.Body.String() || rows() != 3 {
			t.Fatalf("unkeyed: %s %s rows=%d", u1.Body.String(), u2.Body.String(), rows())
		}
		// Shift ownership is checked before the claim, with the same 400.
		other := `{"shiftId":"00000000-0000-4000-8a00-0000000000fe","type":"cash_in","amount":1,"description":"bo keyed"}`
		wantCode(do("/cash-flows", "bo-cf-other", other), 400)
		wantCode(do("/cash-flows", "", other), 400)
		if rows() != 3 {
			t.Fatalf("foreign shift wrote: rows=%d", rows())
		}
	})

	t.Run("discount-code-batch", func(t *testing.T) {
		body := `{"count":3,"prefix":"BOK","suffixLength":6,"type":"fixed","value":1000,"isActive":true}`
		rows := func() int { return count(`SELECT count(*) FROM discount_codes WHERE code LIKE 'BOK%'`) }
		first := do("/discount-codes/batch", "bo-dc-1", body)
		wantCode(first, 200)
		if rows() != 3 || strings.Count(first.Body.String(), `"code":"BOK`) != 3 {
			t.Fatalf("first: %s rows=%d", first.Body.String(), rows())
		}
		again := do("/discount-codes/batch", "bo-dc-1", body)
		wantCode(again, 200)
		if again.Body.String() != first.Body.String() || rows() != 3 {
			t.Fatalf("replay generated or differs: %s rows=%d", again.Body.String(), rows())
		}
		wantCode(do("/discount-codes/batch", "bo-dc-1", strings.Replace(body, `"count":3`, `"count":4`, 1)), 409)
		if rows() != 3 {
			t.Fatalf("conflict wrote: rows=%d", rows())
		}
		u := do("/discount-codes/batch", "", body)
		wantCode(u, 200)
		if rows() != 6 || strings.Count(u.Body.String(), `"code":"BOK`) != 3 {
			t.Fatalf("unkeyed: %s rows=%d", u.Body.String(), rows())
		}
		wantCode(do("/discount-codes/batch", "bo-dc-bad", strings.Replace(body, `"count":3`, `"count":0`, 1)), 400)
		wantCode(do("/discount-codes/batch", "", strings.Replace(body, `"count":3`, `"count":0`, 1)), 400)
	})
}
