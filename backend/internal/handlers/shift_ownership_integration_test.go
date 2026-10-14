package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// TestShiftOwnershipPostgres (A12): one open shift per outlet is held by a partial
// unique index even when the lock path is bypassed, and the direct order and
// cash-flow routes reject a shiftId from another outlet (a closed own shift is
// still accepted: late sales keep their shift).
func TestShiftOwnershipPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "SO", 56453)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const outlet = "00000000-0000-4000-8000-000000000001"
	const other = "00000000-0000-4000-8000-000000000004"
	const user = "00000000-0000-4000-8000-000000000002"
	const product = "00000000-0000-4000-8000-000000000003"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'Synthetic outlet'),($2,'Other outlet')`, outlet, other)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'synthetic@example.invalid','not-a-login-hash','Synthetic cashier','cashier',$2)`, user, outlet)
	exec(`INSERT INTO products(id,name) VALUES($1,'Synthetic product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'SYNTHETIC')`, product)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, outlet, product)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)

	t.Run("index_holds_without_lock", func(t *testing.T) {
		exec(`INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,'c','open',now(),0)`, other, user)
		_, err := pool.Exec(ctx, `INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,'c','open',now(),0)`, other, user)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "23505" {
			t.Fatalf("second open shift must violate the index: %v", err)
		}
		exec(`UPDATE shifts SET status='closed' WHERE outlet_id=$1`, other)
	})

	t.Run("concurrent_opens_one_winner", func(t *testing.T) {
		var wg sync.WaitGroup
		var mu sync.Mutex
		ok, conflict := 0, 0
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := svc.OpenShift(ctx, service.OpenShiftInput{OutletID: outlet, CashierID: user, CashierName: "c"})
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					ok++
				case errors.Is(err, service.ErrShiftOpen):
					conflict++
				default:
					t.Errorf("unexpected: %v", err)
				}
			}()
		}
		wg.Wait()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM shifts WHERE outlet_id=$1 AND status='open'`, outlet).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if ok != 1 || conflict != 9 || n != 1 {
			t.Fatalf("ok=%d conflict=%d open=%d", ok, conflict, n)
		}
		exec(`UPDATE shifts SET status='closed' WHERE outlet_id=$1`, outlet)
	})

	t.Run("unique_violation_maps_to_already_open", func(t *testing.T) {
		// A competing open commits AFTER OpenShift's count (invisible to it): only the
		// index stops the insert, and it must surface as the same conflict, not a 500.
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,'c','open',now(),0)`, outlet, user); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, err := svc.OpenShift(ctx, service.OpenShiftInput{OutletID: outlet, CashierID: user, CashierName: "c"})
			done <- err
		}()
		time.Sleep(500 * time.Millisecond)
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-done; !errors.Is(err, service.ErrShiftOpen) {
			t.Fatalf("want ErrShiftOpen, got %v", err)
		}
		exec(`UPDATE shifts SET status='closed' WHERE outlet_id=$1`, outlet)
	})

	var ownShift, foreignShift string
	if err := pool.QueryRow(ctx, `INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,closed_at,starting_cash) VALUES($1,$2,'c','closed',now(),now(),0) RETURNING id`, outlet, user).Scan(&ownShift); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,'c','open',now(),0) RETURNING id`, other, user).Scan(&foreignShift); err != nil {
		t.Fatal(err)
	}
	secret := []byte("SO-SYNTHETIC-TEST-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/orders", h.CreateOrder)
	router.Post("/cash-flows", h.CreateCashFlow)
	post := func(path, key string, body map[string]any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	seq := 0
	order := func(shift string) *httptest.ResponseRecorder {
		seq++
		b := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8002-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "p", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		if shift != "" {
			b["shiftId"] = shift
		}
		return post("/orders", fmt.Sprintf("so-key-%d", seq), b)
	}
	cashFlow := func(shift string) *httptest.ResponseRecorder {
		b := map[string]any{"type": "in", "amount": 5, "description": "x"}
		if shift != "" {
			b["shiftId"] = shift
		}
		return post("/cash-flows", "", b)
	}
	count := func(q string) int {
		var n int
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for name, bad := range map[string]string{"foreign": foreignShift, "unknown": "00000000-0000-4000-8000-0000000000ff", "malformed": "not-a-uuid"} {
		t.Run("reject_"+name, func(t *testing.T) {
			before := count(`SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM cash_flows)`)
			if w := order(bad); w.Code != http.StatusBadRequest {
				t.Fatalf("order: %d %s", w.Code, w.Body.String())
			}
			if w := cashFlow(bad); w.Code != http.StatusBadRequest {
				t.Fatalf("cash flow: %d %s", w.Code, w.Body.String())
			}
			if after := count(`SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM cash_flows)`); after != before {
				t.Fatalf("rejected requests wrote rows: %d -> %d", before, after)
			}
		})
	}
	t.Run("accepts_closed_own_and_empty", func(t *testing.T) {
		for _, s := range []string{ownShift, ""} {
			if w := order(s); w.Code != http.StatusCreated {
				t.Fatalf("order shift=%q: %d %s", s, w.Code, w.Body.String())
			}
			if w := cashFlow(s); w.Code != http.StatusCreated {
				t.Fatalf("cash flow shift=%q: %d %s", s, w.Code, w.Body.String())
			}
		}
	})
}
