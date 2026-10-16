package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

// A44 oversell record: every sale line that went short of stock (or whose variant
// could not be resolved) leaves one sale_stock_exceptions row, written in the sale
// transaction; a sale is never blocked and stock keeps the true negative on BOTH
// the direct and the sync path. Opt-in only, same isolation contract as the other
// PostgreSQL gates; everything speaks raw JSON over the real HTTP handlers.
func TestOversellPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_OS_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56457 || cfg.ConnConfig.Database != "mandalika_os_synthetic" || cfg.ConnConfig.User != "os_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_OS_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	cur := t
	sub := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(st *testing.T) {
			prev := cur
			cur = st
			defer func() { cur = prev }()
			fn(st)
		})
	}
	exec := func(sql string, args ...any) {
		cur.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			cur.Fatal(err)
		}
	}
	count := func(sql string, args ...any) (n int) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	const (
		outlet  = "00000000-0000-4000-8f00-000000000001"
		outlet2 = "00000000-0000-4000-8f00-000000000002"
		user    = "00000000-0000-4000-8f00-000000000003"
		admin   = "00000000-0000-4000-8f00-000000000004"
		device  = "00000000-0000-4000-8f00-000000000005"
		shift   = "00000000-0000-4000-8f00-000000000006"
		user2   = "00000000-0000-4000-8f00-000000000007"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'OS outlet'),($2,'OS outlet two')`, outlet, outlet2)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'os@example.invalid','x','OS cashier','cashier',$2)`, user, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'os2@example.invalid','x','OS cashier two','cashier',$2)`, user2, outlet2)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'osadmin@example.invalid','x','OS admin','admin')`, admin)
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'OS cashier','open',now(),0)`, shift, outlet, user)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("OS-INTEGRATION-SYNTHETIC-KEY")
	issue := func(uid, role, outletID string, perms ...string) string {
		tk, err := auth.IssueAccess(secret, time.Hour, uid, role, outletID, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	token := issue(user, "cashier", outlet, "create_order", "process_refund")
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("create_order")).Post("/orders", h.CreateOrder)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}

	do := func(tk, method, path string, body any, key string) (int, string) {
		cur.Helper()
		rdr := strings.NewReader("")
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = strings.NewReader(string(raw))
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+tk)
		r.Header.Set("Content-Type", "application/json")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	seq := 0
	newProduct := func(stock int) string {
		cur.Helper()
		seq++
		pid := fmt.Sprintf("00000000-0000-4000-8f10-%012d", seq)
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("OS product %d", seq))
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,0,$2)`, pid, fmt.Sprintf("OS%d", seq))
		if stock >= 0 {
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',$3)`, outlet, pid, stock)
		}
		return pid
	}
	stockOf := func(pid string) int {
		cur.Helper()
		return count(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, pid)
	}
	type sale struct {
		pid string
		qty int
	}
	payload := func(lines ...sale) map[string]any {
		seq++
		items := make([]map[string]any, len(lines))
		total := 0
		for i, l := range lines {
			items[i] = map[string]any{"productId": l.pid, "productName": "OS product", "variantSize": "110ml", "price": 100000, "quantity": l.qty, "subtotal": 100000 * l.qty}
			total += 100000 * l.qty
		}
		return map[string]any{"orderUuid": fmt.Sprintf("00000000-0000-4000-8f20-%012d", seq), "paymentMethod": "cash", "amountPaid": total, "shiftId": shift, "items": items}
	}
	// direct sells through POST /orders and returns the order id.
	direct := func(key string, p map[string]any) string {
		cur.Helper()
		code, body := do(token, "POST", "/orders", p, key)
		if code != 201 && code != 200 {
			cur.Fatalf("direct sale %s: %d %s", key, code, body)
		}
		return count2(cur, pool, ctx, `SELECT id::text FROM orders WHERE idempotency_key=$1`, key)
	}
	// syncSale flushes one order through /sync/batch and returns the item status.
	syncSale := func(key string, p map[string]any) string {
		cur.Helper()
		code, body := do(token, "POST", "/sync/batch", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}}, "")
		var out struct {
			Data struct {
				Results []struct {
					Status string `json:"status"`
				} `json:"results"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %s: %d %s", key, code, body)
		}
		return out.Data.Results[0].Status
	}
	exceptions := func(orderKey string) int {
		cur.Helper()
		return count(`SELECT count(*) FROM sale_stock_exceptions WHERE order_id=(SELECT id FROM orders WHERE idempotency_key=$1)`, orderKey)
	}

	sub("1 sync sale beyond stock records the true negative and one exception row", func(t *testing.T) {
		pid := newProduct(1)
		p := payload(sale{pid, 3})
		p["clientCreatedAt"] = "2026-10-01T03:00:00Z"
		p["deviceId"] = device
		if st := syncSale("os-sync-1", p); st != "ok" {
			t.Fatalf("status %s", st)
		}
		if stockOf(pid) != -2 || count(`SELECT count(*) FROM orders WHERE idempotency_key='os-sync-1' AND stock_warning`) != 1 {
			t.Fatalf("stock=%d", stockOf(pid))
		}
		var kind, channel, cashier, name string
		var qty, before, after, short int
		var soldAt time.Time
		var shiftID, orderNo string
		err := pool.QueryRow(ctx, `SELECT kind,channel,cashier_id::text,cashier_name,quantity,stock_before,stock_after,shortfall,sold_at,shift_id::text,order_number
			FROM sale_stock_exceptions WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='os-sync-1')`).
			Scan(&kind, &channel, &cashier, &name, &qty, &before, &after, &short, &soldAt, &shiftID, &orderNo)
		if err != nil {
			t.Fatal(err)
		}
		if kind != "shortage" || channel != "sync" || cashier != user || name != "OS cashier" || qty != 3 || before != 1 || after != -2 || short != 2 || shiftID != shift || orderNo == "" ||
			!soldAt.Equal(time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)) {
			t.Fatalf("row: %s %s %s %s q=%d %d->%d s=%d sold=%v shift=%s", kind, channel, cashier, name, qty, before, after, short, soldAt, shiftID)
		}
	})

	sub("2 direct sale beyond stock goes negative (not 0) with a direct row", func(t *testing.T) {
		pid := newProduct(0)
		direct("os-direct-2", payload(sale{pid, 1}))
		if stockOf(pid) != -1 {
			t.Fatalf("stock=%d want -1", stockOf(pid))
		}
		if n := count(`SELECT count(*) FROM sale_stock_exceptions WHERE channel='direct' AND shortfall=1 AND stock_before=0 AND stock_after=-1 AND order_id=(SELECT id FROM orders WHERE idempotency_key='os-direct-2')`); n != 1 {
			t.Fatalf("direct rows=%d", n)
		}
	})

	sub("3 replays and concurrent same-key sends leave exactly one row", func(t *testing.T) {
		pid := newProduct(0)
		p := payload(sale{pid, 2})
		syncSale("os-replay-3", p)
		syncSale("os-replay-3", p)
		code, _ := do(token, "POST", "/orders", payload(sale{pid, 1}), "os-direct-replay-3")
		code2, _ := do(token, "POST", "/orders", payload(sale{pid, 1}), "os-direct-replay-3")
		_, _ = code, code2
		if exceptions("os-replay-3") != 1 {
			t.Fatalf("sequential sync replay rows=%d", exceptions("os-replay-3"))
		}
		// Same key, same payload, 6 at once through the sync path.
		cp := payload(sale{pid, 1})
		var wg sync.WaitGroup
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); do(token, "POST", "/sync/batch", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": "os-conc-3", "payload": cp}}}, "") }()
		}
		wg.Wait()
		if exceptions("os-conc-3") != 1 || count(`SELECT count(*) FROM orders WHERE idempotency_key='os-conc-3'`) != 1 {
			t.Fatalf("concurrent rows=%d", exceptions("os-conc-3"))
		}
		// stock moved exactly once per distinct sale: 2 + 1 (direct) + 1 (concurrent) = -4
		if stockOf(pid) != -4 {
			t.Fatalf("stock=%d want -4 (each key applied once)", stockOf(pid))
		}
	})

	sub("4 several lines of one SKU: shortfall sums to what went below zero", func(t *testing.T) {
		pid := newProduct(1)
		direct("os-multi-4", payload(sale{pid, 1}, sale{pid, 2}))
		if stockOf(pid) != -2 {
			t.Fatalf("stock=%d", stockOf(pid))
		}
		var rows, sum int
		if err := pool.QueryRow(ctx, `SELECT count(*), COALESCE(sum(shortfall),0) FROM sale_stock_exceptions WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='os-multi-4')`).Scan(&rows, &sum); err != nil {
			t.Fatal(err)
		}
		// line 1 covered by the 1 on hand (no row); line 2 fully short (2).
		if rows != 1 || sum != 2 {
			t.Fatalf("rows=%d shortfall=%d", rows, sum)
		}
	})

	sub("5 refund of an oversold order restores the pre-sale stock exactly; the row is unchanged", func(t *testing.T) {
		pid := newProduct(0)
		id := direct("os-refund-5", payload(sale{pid, 2}))
		var before string
		if err := pool.QueryRow(ctx, `SELECT to_jsonb(x)::text FROM sale_stock_exceptions x WHERE order_id=$1`, id).Scan(&before); err != nil {
			t.Fatal(err)
		}
		if code, body := do(token, "POST", "/orders/"+id+"/refund", map[string]any{"reason": "salah input"}, ""); code != 200 && code != 201 {
			t.Fatalf("refund %d %s", code, body)
		}
		if stockOf(pid) != 0 {
			t.Fatalf("stock=%d want 0 (sale -2 then refund +2)", stockOf(pid))
		}
		var after string
		if err := pool.QueryRow(ctx, `SELECT to_jsonb(x)::text FROM sale_stock_exceptions x WHERE order_id=$1`, id).Scan(&after); err != nil || after != before {
			t.Fatalf("row changed by refund: %s vs %s err=%v", before, after, err)
		}
	})

	sub("6 a sale within stock writes no row and no warning", func(t *testing.T) {
		pid := newProduct(5)
		direct("os-ok-6", payload(sale{pid, 5}))
		if stockOf(pid) != 0 || exceptions("os-ok-6") != 0 || count(`SELECT count(*) FROM orders WHERE idempotency_key='os-ok-6' AND stock_warning`) != 0 {
			t.Fatalf("stock=%d rows=%d", stockOf(pid), exceptions("os-ok-6"))
		}
	})
	_ = bytes.MinRead
	_ = admin
	_ = user2
	_ = outlet2
}

func count2(t *testing.T, pool *pgxpool.Pool, ctx context.Context, sql string, args ...any) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

var _ = http.StatusOK
