package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A11: keyed /sync/batch writes (refund, shift_open, shift_close, cash_flow,
// customer_create) must apply once per idempotency key even when the POS retries
// after a lost response. Everything is driven through the real /sync/batch
// handler and checked with plain SQL, so the same test runs against unfixed code.
// Subtests tagged [unfixed-fails] fail on the pre-A11 code; the others are
// regression guards for behaviour that was already idempotent.
// Opt-in fresh synthetic cluster only; same target guards as the other gates.
func TestOperationReceiptsPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_OR_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated operation-receipts PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56446 || cfg.ConnConfig.Database != "mandalika_or_synthetic" || cfg.ConnConfig.User != "or_test" {
		t.Fatal("refusing non-fixture target")
	}
	cfg.MaxConns = 12
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_OR_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}

	t.Run("concurrent-migrate [unfixed-fails]", func(t *testing.T) {
		files, err := filepath.Glob(filepath.Join("..", "db", "migrations", "*.sql"))
		if err != nil || len(files) == 0 {
			t.Fatalf("migration files: %d %v", len(files), err)
		}
		errs := make([]error, 4)
		var wg sync.WaitGroup
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				errs[i] = (&db.DB{Pool: pool}).Migrate(ctx)
			}(i)
		}
		wg.Wait()
		for i, e := range errs {
			if e != nil {
				t.Errorf("migrate %d: %v", i, e)
			}
		}
		var applied, distinct int
		if err := pool.QueryRow(ctx, `SELECT count(*), count(DISTINCT name) FROM schema_migrations`).Scan(&applied, &distinct); err != nil {
			t.Fatal(err)
		}
		if applied != len(files) || distinct != len(files) {
			t.Errorf("schema_migrations has %d rows (%d distinct), want %d", applied, distinct, len(files))
		}
	})
	// A race that lost on unfixed code leaves only whole-file rollbacks; finish
	// the schema sequentially so the remaining cases still run.
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	const outletA = "00000000-0000-4000-8a00-000000000001"
	const outletB = "00000000-0000-4000-8a00-000000000002"
	const userA = "00000000-0000-4000-8a00-000000000011"
	const userB = "00000000-0000-4000-8a00-000000000012"
	exec := func(t testing.TB, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	count := func(t testing.TB, sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}
	exec(t, `INSERT INTO outlets(id,name) VALUES($1,'OR outlet A'),($2,'OR outlet B')`, outletA, outletB)
	exec(t, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'a@example.invalid','x','OR cashier A','cashier',$3),
		($2,'b@example.invalid','x','OR cashier B','cashier',$4)`, userA, userB, outletA, outletB)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("OR-SYNTHETIC-TEST-KEY")
	issue := func(user, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"process_refund"})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokenA, tokenB := issue(userA, outletA), issue(userB, outletB)
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/sync/batch", h.SyncBatch)

	// one sends a single-item /sync/batch request and returns that item's result.
	one := func(t testing.TB, token, typ, key, payload string) syncpkg.ItemResult {
		t.Helper()
		body := fmt.Sprintf(`{"items":[{"type":%q,"idempotencyKey":%q,"payload":%s}]}`, typ, key, payload)
		r := httptest.NewRequest("POST", "/sync/batch", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Data.Results) != 1 {
			t.Fatalf("batch: %d %s %v", w.Code, w.Body.String(), err)
		}
		return out.Data.Results[0]
	}
	wantOK := func(t testing.TB, r syncpkg.ItemResult) {
		t.Helper()
		if r.Status != "ok" || r.Error != "" || r.OrderID == "" {
			t.Fatalf("want ok with an id, got %+v", r)
		}
	}
	const conflictText = "kunci idempotensi sudah dipakai untuk operasi lain"
	wantConflict := func(t testing.TB, r syncpkg.ItemResult, leak string) {
		t.Helper()
		if r.Status != "error" || r.Error != conflictText || r.OrderID != "" {
			t.Fatalf("want idempotency conflict, got %+v", r)
		}
		if strings.Contains(r.Error, leak) {
			t.Fatalf("conflict leaks %q: %+v", leak, r)
		}
	}
	receipts := func(t testing.TB) int { return count(t, `SELECT count(*) FROM operation_receipts`) }
	tr := &trFixture{ctx: ctx, pool: pool}

	var shiftID string
	t.Run("shift_open-retry-same-key [unfixed-fails]", func(t *testing.T) {
		p := `{"startingCash":100,"outletName":"OR outlet A"}`
		first := one(t, tokenA, "shift_open", "or-dev:shift-open-1", p)
		wantOK(t, first)
		shiftID = first.OrderID
		again := one(t, tokenA, "shift_open", "or-dev:shift-open-1", p)
		wantOK(t, again)
		if again != first {
			t.Errorf("replay %+v differs from first result %+v", again, first)
		}
		if n := count(t, `SELECT count(*) FROM shifts WHERE outlet_id=$1`, outletA); n != 1 {
			t.Errorf("%d shifts, want 1", n)
		}
	})
	if shiftID == "" {
		t.Fatal("no shift")
	}

	t.Run("cash_flow-retry-same-key [unfixed-fails]", func(t *testing.T) {
		p := fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":25000,"description":"or-cash-1"}`, shiftID)
		first := one(t, tokenA, "cash_flow", "or-dev:cash-1", p)
		wantOK(t, first)
		again := one(t, tokenA, "cash_flow", "or-dev:cash-1", p)
		if again != first {
			t.Errorf("replay %+v differs from first result %+v", again, first)
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cash-1'`); n != 1 {
			t.Errorf("%d cash_flows rows, want 1", n)
		}
	})

	t.Run("cash_flow-equivalent-payload-different-key-order [unfixed-fails]", func(t *testing.T) {
		first := one(t, tokenA, "cash_flow", "or-dev:cash-order", fmt.Sprintf(`{"shiftId":%q,"type":"out","amount":10,"description":"or-cash-order"}`, shiftID))
		wantOK(t, first)
		again := one(t, tokenA, "cash_flow", "or-dev:cash-order", fmt.Sprintf(`{ "description":"or-cash-order", "amount":10, "type":"out", "shiftId":%q }`, shiftID))
		if again != first {
			t.Errorf("replay %+v differs from first result %+v", again, first)
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cash-order'`); n != 1 {
			t.Errorf("%d rows, want 1", n)
		}
	})

	t.Run("cash_flow-two-keys-same-payload-two-effects", func(t *testing.T) {
		p := fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":5,"description":"or-cash-twin"}`, shiftID)
		a, b := one(t, tokenA, "cash_flow", "or-dev:twin-a", p), one(t, tokenA, "cash_flow", "or-dev:twin-b", p)
		wantOK(t, a)
		wantOK(t, b)
		if a.OrderID == b.OrderID {
			t.Errorf("distinct keys returned the same id %s", a.OrderID)
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cash-twin'`); n != 2 {
			t.Errorf("%d rows, want 2 (different keys are different operations)", n)
		}
	})

	t.Run("cash_flow-concurrent-same-key [unfixed-fails]", func(t *testing.T) {
		p := fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":7,"description":"or-cash-race"}`, shiftID)
		results := make([]syncpkg.ItemResult, 2)
		op := func(i int) func(context.Context) error {
			return func(context.Context) error {
				results[i] = one(t, tokenA, "cash_flow", "or-dev:cash-race", p)
				return nil
			}
		}
		// Both requests park (one on the table lock, the other on the receipt's
		// unique index when fixed) before the lock is released.
		tr.race(t, "cash_flows", op(0), op(1))
		wantOK(t, results[0])
		if results[1] != results[0] {
			t.Errorf("concurrent results differ: %+v vs %+v", results[0], results[1])
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cash-race'`); n != 1 {
			t.Errorf("%d rows, want 1", n)
		}
	})

	t.Run("cash_flow-same-key-different-payload [unfixed-fails]", func(t *testing.T) {
		first := one(t, tokenA, "cash_flow", "or-dev:cash-fp", fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":1,"description":"or-cash-fp"}`, shiftID))
		wantOK(t, first)
		before, rc := count(t, `SELECT count(*) FROM cash_flows`), receipts(t)
		wantConflict(t, one(t, tokenA, "cash_flow", "or-dev:cash-fp", fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":2,"description":"or-cash-fp"}`, shiftID)), first.OrderID)
		if after := count(t, `SELECT count(*) FROM cash_flows`); after != before || receipts(t) != rc {
			t.Errorf("conflict changed data: cash %d->%d receipts %d->%d", before, after, rc, receipts(t))
		}
	})

	t.Run("key-reused-for-other-type [unfixed-fails]", func(t *testing.T) {
		first := one(t, tokenA, "cash_flow", "or-dev:cross-type", fmt.Sprintf(`{"shiftId":%q,"type":"in","amount":3,"description":"or-cross-type"}`, shiftID))
		wantOK(t, first)
		rc := receipts(t)
		wantConflict(t, one(t, tokenA, "customer_create", "or-dev:cross-type", `{"customerId":"00000000-0000-4000-8a01-0000000000f1","name":"Cross Type","phone":"0800-cross"}`), first.OrderID)
		if n := count(t, `SELECT count(*) FROM customers WHERE phone='0800-cross'`); n != 0 {
			t.Errorf("conflicting op created %d customers", n)
		}
		if receipts(t) != rc {
			t.Error("conflict changed receipts")
		}
	})

	t.Run("key-reused-by-other-outlet [unfixed-fails]", func(t *testing.T) {
		p := `{"type":"in","amount":9,"description":"or-cross-outlet"}`
		first := one(t, tokenA, "cash_flow", "or-dev:cross-outlet", p)
		wantOK(t, first)
		// Identical type and payload from another outlet must not replay A's outcome.
		wantConflict(t, one(t, tokenB, "cash_flow", "or-dev:cross-outlet", p), first.OrderID)
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cross-outlet'`); n != 1 {
			t.Errorf("%d rows, want 1", n)
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description='or-cross-outlet' AND outlet_id=$1`, outletB); n != 0 {
			t.Errorf("outlet B received %d rows", n)
		}
	})

	t.Run("customer_create-retry-and-duplicate-candidate", func(t *testing.T) {
		p1 := `{"customerId":"00000000-0000-4000-8a01-000000000001","name":"First","phone":"0800-dup"}`
		first := one(t, tokenA, "customer_create", "or-dev:cust-1", p1)
		wantOK(t, first)
		if first.OrderID != "00000000-0000-4000-8a01-000000000001" {
			t.Errorf("customer id %q", first.OrderID)
		}
		if again := one(t, tokenA, "customer_create", "or-dev:cust-1", p1); again != first {
			t.Errorf("replay %+v differs from %+v", again, first)
		}
		// Same phone, new customer: the best-effort duplicate candidate runs in a
		// savepoint inside the receipt transaction and must not break it.
		p2 := `{"customerId":"00000000-0000-4000-8a01-000000000002","name":"Second","phone":"0800-dup"}`
		wantOK(t, one(t, tokenA, "customer_create", "or-dev:cust-2", p2))
		if n := count(t, `SELECT count(*) FROM customers WHERE phone='0800-dup'`); n != 2 {
			t.Errorf("%d customers, want 2", n)
		}
		if n := count(t, `SELECT count(*) FROM customer_dup_candidates WHERE phone='0800-dup'`); n != 1 {
			t.Errorf("%d duplicate candidates, want 1", n)
		}
	})

	// Orders are inserted directly: refund only needs a completed order with
	// lines and the outlet stock row.
	const product = "00000000-0000-4000-8a02-000000000001"
	exec(t, `INSERT INTO products(id,name) VALUES($1,'OR product')`, product)
	exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',5)`, outletA, product)
	order := func(t testing.TB, id string, n int) {
		t.Helper()
		exec(t, `INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status)
			VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'OR cashier A',100,100,'cash','completed')`,
			id, fmt.Sprintf("OR-%06d", n), fmt.Sprintf("or-order-key-%d", n), outletA, userA)
		exec(t, `INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'OR product','M',50,2,100)`, id, product)
	}
	refunded := func(t testing.TB, id string) int {
		return count(t, `SELECT count(*) FROM orders WHERE id=$1 AND status='refunded'`, id)
	}

	t.Run("refund-retry-same-key [regression guard: already idempotent]", func(t *testing.T) {
		id := "00000000-0000-4000-8a03-000000000001"
		order(t, id, 1)
		p := fmt.Sprintf(`{"orderId":%q,"reason":"or-refund"}`, id)
		first := one(t, tokenA, "refund", "or-dev:refund-1", p)
		wantOK(t, first)
		if first.OrderID != id {
			t.Errorf("refund result id %q, want %q", first.OrderID, id)
		}
		if again := one(t, tokenA, "refund", "or-dev:refund-1", p); again != first {
			t.Errorf("replay %+v differs from %+v", again, first)
		}
		if got := count(t, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2`, outletA, product); got != 7 {
			t.Errorf("stock %d, want 7 (restored once)", got)
		}
		if refunded(t, id) != 1 {
			t.Error("order not refunded")
		}
	})

	t.Run("refund-failure-is-not-pinned", func(t *testing.T) {
		id := "00000000-0000-4000-8a03-000000000002"
		p := fmt.Sprintf(`{"orderId":%q,"reason":"or-late"}`, id)
		rc := receipts(t)
		if failed := one(t, tokenA, "refund", "or-dev:refund-late", p); failed.Status != "error" || failed.Error == "" {
			t.Fatalf("want error, got %+v", failed)
		}
		if receipts(t) != rc {
			t.Fatal("a failed operation left a receipt")
		}
		// The order only exists later: the retry with the same key must run for
		// real, not replay the failure.
		order(t, id, 2)
		wantOK(t, one(t, tokenA, "refund", "or-dev:refund-late", p))
		if refunded(t, id) != 1 {
			t.Error("retry did not refund")
		}
	})

	t.Run("shift_close-retry-same-key [regression guard: already idempotent]", func(t *testing.T) {
		p := fmt.Sprintf(`{"shiftId":%q,"closingCash":50}`, shiftID)
		first := one(t, tokenA, "shift_close", "or-dev:shift-close-1", p)
		wantOK(t, first)
		if first.OrderID != shiftID {
			t.Errorf("close result id %q, want %q", first.OrderID, shiftID)
		}
		if again := one(t, tokenA, "shift_close", "or-dev:shift-close-1", p); again != first {
			t.Errorf("replay %+v differs from %+v", again, first)
		}
		if n := count(t, `SELECT count(*) FROM shifts WHERE id=$1 AND status='closed' AND closing_cash=50`, shiftID); n != 1 {
			t.Error("shift not closed once")
		}
	})

	t.Run("shift_close-of-missing-shift-is-not-pinned", func(t *testing.T) {
		rc := receipts(t)
		if r := one(t, tokenA, "shift_close", "or-dev:close-missing", `{"shiftId":"00000000-0000-4000-8a04-000000000001","closingCash":0}`); r.Status != "error" {
			t.Fatalf("want error, got %+v", r)
		}
		if receipts(t) != rc {
			t.Fatal("a failed operation left a receipt")
		}
	})
}
