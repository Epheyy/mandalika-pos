package handlers

import (
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

// A14 product stock count: the server owns the baseline and completion applies the
// counted difference (final = current + counted - frozen), so sales made during a
// count survive and a retried completion cannot restore the old count. Opt-in only,
// same isolation contract as the other PostgreSQL gates. Everything speaks raw JSON
// over HTTP; sales go through the real POST /orders path.
func TestStockCountPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_SC_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56451 || cfg.ConnConfig.Database != "mandalika_sc_synthetic" || cfg.ConnConfig.User != "sc_test" {
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
	expected := os.Getenv("MANDALIKA_SC_TEST_DATA_DIR")
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
	// Subtests share these helpers; failures must target the running subtest.
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
		outlet    = "00000000-0000-4000-8e00-000000000001"
		user      = "00000000-0000-4000-8e00-000000000002"
		warehouse = "00000000-0000-4000-8e00-000000000003"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'SC outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'sc@example.invalid','x','SC cashier','cashier',$2)`, user, outlet)
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'SC warehouse')`, warehouse)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("SC-INTEGRATION-SYNTHETIC-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order", "manage_stock_count"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("create_order")).Post("/orders", h.CreateOrder)
	router.With(authWrap).Get("/stock-counts/{id}", h.StockCount)
	router.With(authWrap, mw.RequirePermission("manage_stock_count")).Post("/stock-counts", h.CreateStockCount)
	router.With(authWrap, mw.RequirePermission("manage_stock_count")).Put("/stock-counts/{id}", h.UpdateStockCount)
	router.With(authWrap, mw.RequirePermission("manage_stock_count")).Post("/stock-counts/{id}/complete", h.CompleteStockCount)
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}

	do := func(method, path string, body any, key string) (int, string) {
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
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	seq := 0
	// newProduct makes a fresh product with one 110ml variant; stock < 0 leaves the
	// outlet stock row absent (a missing row counts as 0).
	newProduct := func(stock int) string {
		cur.Helper()
		seq++
		pid := fmt.Sprintf("00000000-0000-4000-8e10-%012d", seq)
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("SC product %d", seq))
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,0,$2)`, pid, fmt.Sprintf("SC%d", seq))
		if stock >= 0 {
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',$3)`, outlet, pid, stock)
		}
		return pid
	}
	stockOf := func(pid string) int {
		cur.Helper()
		return count(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, pid)
	}
	whStockOf := func(pid string) int {
		cur.Helper()
		return count(`SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size='110ml'`, warehouse, pid)
	}
	version := func() int {
		cur.Helper()
		return count(`SELECT version FROM content_versions WHERE outlet_id=$1`, outlet)
	}
	// sell goes through the real sale path (POST /orders): stock is decremented by
	// service/order.go, not by this test.
	sell := func(pid string, qty int) {
		cur.Helper()
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8e20-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000 * qty,
			"items": []map[string]any{{"productId": pid, "productName": "SC product", "variantSize": "110ml", "price": 100000, "quantity": qty, "subtotal": 100000 * qty}},
		}
		if code, body := do("POST", "/orders", p, fmt.Sprintf("sc-sale-%d", seq)); code != 201 {
			cur.Fatalf("sale: %d %s", code, body)
		}
	}
	line := func(pid string, actual any) map[string]any {
		return map[string]any{"productId": pid, "productName": "SC product", "variantSize": "110ml", "sku": "SC", "actualQty": actual}
	}
	// lineJunk also sends client-computed fields the server must never trust.
	lineJunk := func(pid string, actual any) map[string]any {
		l := line(pid, actual)
		l["frozenQty"], l["difference"], l["baselineQty"], l["stockBefore"], l["stockAfter"] = 999, 888, 777, 666, 555
		return l
	}
	create := func(items ...map[string]any) string {
		cur.Helper()
		code, body := do("POST", "/stock-counts", map[string]any{"name": "SC count", "items": items}, "")
		var out struct {
			Data struct{ ID string } `json:"data"`
		}
		if code != 201 || json.Unmarshal([]byte(body), &out) != nil || out.Data.ID == "" {
			cur.Fatalf("create: %d %s", code, body)
		}
		return out.Data.ID
	}
	put := func(id string, body map[string]any) (int, string) { return do("PUT", "/stock-counts/"+id, body, "") }
	complete := func(id string, items ...map[string]any) (int, string) {
		var body any
		if items != nil {
			body = map[string]any{"items": items}
		}
		return do("POST", "/stock-counts/"+id+"/complete", body, "")
	}
	must := func(what string, code int, body string, want int) {
		cur.Helper()
		if code != want {
			cur.Fatalf("%s: status %d want %d: %s", what, code, want, body)
		}
	}
	type item struct {
		ProductID   string  `json:"productId"`
		FrozenQty   int     `json:"frozenQty"`
		ActualQty   *int    `json:"actualQty"`
		Difference  *int    `json:"difference"`
		BaselineQty *int    `json:"baselineQty"`
		CountedAt   *string `json:"countedAt"`
		StockBefore *int    `json:"stockBefore"`
		StockAfter  *int    `json:"stockAfter"`
	}
	type view struct {
		Status      string  `json:"status"`
		CompletedAt *string `json:"completedAt"`
		Items       []item  `json:"items"`
	}
	get := func(id string) view {
		cur.Helper()
		code, body := do("GET", "/stock-counts/"+id, nil, "")
		var out struct {
			Data view `json:"data"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil {
			cur.Fatalf("get: %d %s", code, body)
		}
		return out.Data
	}
	only := func(id string) item {
		cur.Helper()
		v := get(id)
		if len(v.Items) != 1 {
			cur.Fatalf("want exactly one line, got %d", len(v.Items))
		}
		return v.Items[0]
	}
	intp := func(label string, p *int, want int) {
		cur.Helper()
		if p == nil || *p != want {
			cur.Fatalf("%s = %v, want %d", label, p, want)
		}
	}
	eq := func(label string, got, want int) {
		cur.Helper()
		if got != want {
			cur.Fatalf("%s = %d, want %d", label, got, want)
		}
	}
	start := func(id string) {
		cur.Helper()
		code, body := put(id, map[string]any{"status": "in_progress"})
		must("start", code, body, 200)
	}

	sub("1 frozen fallback applies zero variance and keeps the sale; replay is a no-op", func(t *testing.T) {
		pid := newProduct(10)
		id := create(lineJunk(pid, nil))
		start(id)
		sell(pid, 2)
		code, body := complete(id, line(pid, 10))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 8 {
			t.Fatalf("stock after complete = %d, want 8 (sale kept)", got)
		}
		done1 := get(id).CompletedAt
		it := only(id)
		intp("difference", it.Difference, 0)
		intp("stockBefore", it.StockBefore, 8)
		intp("stockAfter", it.StockAfter, 8)
		// Replay (double click / retry) after another sale: zero writes.
		sell(pid, 1)
		v2 := version()
		for i := 0; i < 2; i++ {
			code, body = complete(id, line(pid, 10))
			must("replay", code, body, 200)
		}
		if got := stockOf(pid); got != 7 {
			t.Fatalf("replay changed stock: %d, want 7", got)
		}
		if version() != v2 {
			t.Fatalf("replay bumped the content version")
		}
		if v := get(id); v.Status != "completed" || v.CompletedAt == nil || done1 == nil || *v.CompletedAt != *done1 {
			t.Fatalf("replay rewrote the completed count: %+v", v)
		}
		if it2 := only(id); it2.StockAfter == nil || *it2.StockAfter != 8 || *it2.StockBefore != 8 {
			t.Fatalf("replay rewrote audit columns: %+v", it2)
		}
	})

	sub("2 owner examples: frozen 15, 3 sold, counted 14 -> 11 and counted 16 -> 13", func(t *testing.T) {
		for _, c := range []struct{ counted, want int }{{14, 11}, {16, 13}} {
			pid := newProduct(15)
			id := create(line(pid, nil))
			start(id)
			sell(pid, 3)
			before := version()
			code, body := complete(id, line(pid, c.counted))
			must("complete", code, body, 200)
			if got := stockOf(pid); got != c.want {
				t.Fatalf("counted %d: stock=%d want %d", c.counted, got, c.want)
			}
			if version() <= before {
				t.Fatalf("outlet count must bump the content version")
			}
			it := only(id)
			intp("difference", it.Difference, c.counted-15)
			intp("stockBefore", it.StockBefore, 12)
			intp("stockAfter", it.StockAfter, c.want)
			intp("frozenQty", &it.FrozenQty, 15)
		}
	})

	sub("3 per-line save captures the baseline at entry time", func(t *testing.T) {
		pid := newProduct(15)
		id := create(line(pid, nil))
		start(id)
		sell(pid, 3) // stock 12, sold before the physical count
		code, body := put(id, map[string]any{"items": []any{lineJunk(pid, 11)}})
		must("save line", code, body, 200)
		it := only(id)
		intp("baselineQty", it.BaselineQty, 12)
		intp("frozenQty", &it.FrozenQty, 15)
		intp("actualQty", it.ActualQty, 11)
		if it.CountedAt == nil {
			t.Fatal("countedAt must be set on a counted line")
		}
		code, body = complete(id)
		must("complete without payload", code, body, 200)
		if got := stockOf(pid); got != 11 {
			t.Fatalf("stock = %d, want 11 (sold-before-count not subtracted twice)", got)
		}
		it = only(id)
		intp("difference", it.Difference, -1)
		intp("stockBefore", it.StockBefore, 12)
		intp("stockAfter", it.StockAfter, 11)
	})

	sub("4 same value re-sent in Complete keeps the per-line baseline; clearing clears it", func(t *testing.T) {
		pid := newProduct(15)
		id := create(line(pid, nil))
		start(id)
		sell(pid, 3)
		code, body := put(id, map[string]any{"items": []any{line(pid, 11)}})
		must("save line", code, body, 200)
		sell(pid, 1) // stock 11 after the baseline was captured at 12
		// Re-sending the same value must not recapture or reset the baseline.
		code, body = put(id, map[string]any{"items": []any{line(pid, 11)}})
		must("resave same", code, body, 200)
		intp("baselineQty kept", only(id).BaselineQty, 12)
		code, body = complete(id, line(pid, 11))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 10 {
			t.Fatalf("stock = %d, want 10 (11 + (11-12))", got)
		}
		// Clearing a line drops actual, baseline and timestamp, and applies nothing.
		pid2 := newProduct(5)
		id2 := create(line(pid2, nil))
		start(id2)
		for _, a := range []any{4, nil} {
			code, body = put(id2, map[string]any{"items": []any{line(pid2, a)}})
			must("save/clear", code, body, 200)
		}
		it := only(id2)
		if it.ActualQty != nil || it.BaselineQty != nil || it.CountedAt != nil {
			t.Fatalf("clear must drop actual/baseline/countedAt: %+v", it)
		}
		code, body = complete(id2)
		must("complete uncounted", code, body, 200)
		if got := stockOf(pid2); got != 5 {
			t.Fatalf("uncounted line changed stock: %d", got)
		}
	})

	sub("5 client frozen/difference/baseline are ignored; complete never adds products", func(t *testing.T) {
		pid, other := newProduct(10), newProduct(10)
		id := create(lineJunk(pid, 5))
		it := only(id)
		intp("frozenQty at create", &it.FrozenQty, 10)
		if it.ActualQty != nil || it.Difference != nil || it.BaselineQty != nil || it.StockBefore != nil || it.StockAfter != nil {
			t.Fatalf("create stored client-computed fields: %+v", it)
		}
		code, body := put(id, map[string]any{"items": []any{lineJunk(pid, nil)}})
		must("planned replace", code, body, 200)
		eq("frozenQty after replace", only(id).FrozenQty, 10)
		start(id)
		code, body = put(id, map[string]any{"items": []any{lineJunk(pid, 9)}})
		must("save line", code, body, 200)
		eq("frozenQty after save", only(id).FrozenQty, 10)
		// A product that is not on the count cannot be added at completion.
		code, body = complete(id, line(pid, 9), line(other, 1))
		must("complete with foreign line", code, body, 400)
		if get(id).Status != "in_progress" || stockOf(pid) != 10 || stockOf(other) != 10 {
			t.Fatal("rejected complete must apply nothing")
		}
		code, body = complete(id, lineJunk(pid, 9))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 9 {
			t.Fatalf("stock = %d, want 9", got)
		}
		eq("frozenQty after complete", only(id).FrozenQty, 10)
		if got := stockOf(other); got != 10 {
			t.Fatalf("foreign product touched: %d", got)
		}
	})

	sub("6 start re-freezes a planned count; a second start does not", func(t *testing.T) {
		pid := newProduct(10)
		id := create(line(pid, nil))
		sell(pid, 3) // planned for days, sales happen
		start(id)
		eq("frozen after start", only(id).FrozenQty, 7)
		sell(pid, 2)
		start(id) // double click: no-op 200, no re-freeze
		eq("frozen after repeat start", only(id).FrozenQty, 7)
		code, body := complete(id, line(pid, 7))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 5 {
			t.Fatalf("stock = %d, want 5", got)
		}
	})

	sub("7 concurrent completes apply the delta exactly once", func(t *testing.T) {
		pid := newProduct(15)
		id := create(line(pid, nil))
		start(id)
		code, body := put(id, map[string]any{"items": []any{line(pid, 14)}})
		must("save line", code, body, 200)
		sell(pid, 3) // stock 12; delta is 14-15 = -1
		const n = 8
		codes := make([]int, n)
		bodies := make([]string, n)
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				r := httptest.NewRequest("POST", "/stock-counts/"+id+"/complete", strings.NewReader(`{}`))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				codes[i], bodies[i] = w.Code, w.Body.String()
			}(i)
		}
		wg.Wait()
		for i := range codes {
			if codes[i] != http.StatusOK {
				t.Fatalf("complete %d: %d %s", i, codes[i], bodies[i])
			}
		}
		if got := stockOf(pid); got != 11 {
			t.Fatalf("stock = %d, want 11 (applied exactly once)", got)
		}
	})

	sub("8 lifecycle guards", func(t *testing.T) {
		pid := newProduct(10)
		a := create(line(pid, nil))
		start(a)
		// Overlap: a second count cannot start at the same location.
		b := create(line(pid, nil))
		code, body := put(b, map[string]any{"status": "in_progress"})
		must("second start", code, body, 409)
		if !strings.Contains(body, "masih berjalan") {
			t.Fatalf("overlap message: %s", body)
		}
		code, body = complete(b, line(pid, 1))
		must("complete planned", code, body, 409)
		if stockOf(pid) != 10 {
			t.Fatal("rejected complete changed stock")
		}
		code, body = put(b, map[string]any{"status": "cancelled"})
		must("cancel planned", code, body, 200)
		code, body = put(b, map[string]any{"status": "cancelled"})
		must("cancel again is a no-op", code, body, 200)
		code, body = complete(b, line(pid, 1))
		must("complete cancelled", code, body, 409)
		code, body = put(b, map[string]any{"items": []any{line(pid, 1)}})
		must("edit cancelled", code, body, 409)
		code, body = put(b, map[string]any{"status": "in_progress"})
		must("start cancelled", code, body, 409)
		// Bad input on the running count.
		code, body = put(a, map[string]any{"status": "bogus"})
		must("unknown status", code, body, 400)
		code, body = put(a, map[string]any{"status": "completed"})
		must("completed is not settable via PUT", code, body, 400)
		code, body = put(a, map[string]any{"items": []any{line(newProduct(1), 1)}})
		must("unknown line", code, body, 400)
		code, body = put(a, map[string]any{"items": []any{line(pid, -1)}})
		must("negative count", code, body, 400)
		if it := only(a); it.ActualQty != nil {
			t.Fatalf("rejected edits left state behind: %+v", it)
		}
		code, body = complete(a, line(pid, 10))
		must("complete", code, body, 200)
		// Everything is closed once completed.
		for name, req := range map[string]map[string]any{
			"start":  {"status": "in_progress"},
			"cancel": {"status": "cancelled"},
			"items":  {"items": []any{line(pid, 3)}},
			"notes":  {"notes": "late note"},
		} {
			code, body = put(a, req)
			must("completed "+name, code, body, 409)
		}
		if stockOf(pid) != 10 {
			t.Fatal("edits on a completed count changed stock")
		}
		// After completion the location is free again.
		c := create(line(pid, nil))
		start(c)
		code, body = put(c, map[string]any{"status": "cancelled"})
		must("cancel running", code, body, 200)
	})

	sub("9 warehouse count applies the delta to warehouse stock without a content bump", func(t *testing.T) {
		pid := newProduct(-1)
		exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',10)`, warehouse, pid)
		code, body := do("POST", "/stock-counts", map[string]any{"name": "SC wh", "warehouseId": warehouse, "items": []any{line(pid, nil)}}, "")
		var out struct {
			Data struct{ ID string } `json:"data"`
		}
		if code != 201 || json.Unmarshal([]byte(body), &out) != nil {
			t.Fatalf("create: %d %s", code, body)
		}
		id := out.Data.ID
		start(id)
		eq("frozen", only(id).FrozenQty, 10)
		code, body = put(id, map[string]any{"items": []any{line(pid, 7)}})
		must("save line", code, body, 200)
		intp("baseline", only(id).BaselineQty, 10)
		exec(`UPDATE warehouse_variant_stock SET stock=12 WHERE warehouse_id=$1 AND product_id=$2`, warehouse, pid) // goods received meanwhile
		before := version()
		code, body = complete(id)
		must("complete", code, body, 200)
		if got := whStockOf(pid); got != 9 {
			t.Fatalf("warehouse stock = %d, want 9 (12 + (7-10))", got)
		}
		if version() != before {
			t.Fatal("warehouse count must not bump the content version")
		}
		it := only(id)
		intp("stockBefore", it.StockBefore, 12)
		intp("stockAfter", it.StockAfter, 9)
	})

	sub("10 a missing stock row counts as zero and is created on completion", func(t *testing.T) {
		pid := newProduct(-1)
		id := create(line(pid, nil))
		eq("frozen", only(id).FrozenQty, 0)
		start(id)
		code, body := complete(id, line(pid, 4))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 4 {
			t.Fatalf("stock = %d, want 4", got)
		}
	})

	sub("11 a negative result is kept, not clamped", func(t *testing.T) {
		pid := newProduct(5)
		id := create(line(pid, nil))
		start(id)
		sell(pid, 5) // stock 0
		code, body := complete(id, line(pid, 0))
		must("complete", code, body, 200) // counted 0 vs frozen 5: delta -5
		if got := stockOf(pid); got != -5 {
			t.Fatalf("stock = %d, want -5 (error stays visible)", got)
		}
		intp("stockAfter", only(id).StockAfter, -5)
	})

	sub("12 replay with a non-zero delta never re-applies; a differing replay payload is 409", func(t *testing.T) {
		pid := newProduct(15)
		id := create(line(pid, nil))
		start(id)
		sell(pid, 3) // stock 12
		code, body := complete(id, line(pid, 14))
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 11 {
			t.Fatalf("stock = %d, want 11", got)
		}
		sell(pid, 1) // 10
		for _, items := range [][]map[string]any{{line(pid, 14)}, {}, nil} {
			code, body = complete(id, items...)
			must("identical or empty replay", code, body, 200)
		}
		if got := stockOf(pid); got != 10 {
			t.Fatalf("replay re-applied the delta: stock = %d, want 10", got)
		}
		// A replay carrying other values must not look like success.
		code, body = complete(id, line(pid, 3))
		must("replay with another value", code, body, 409)
		if !strings.Contains(body, "selesai dengan nilai lain") {
			t.Fatalf("message: %s", body)
		}
		code, body = complete(id, line(newProduct(1), 1))
		must("replay with a line not in the count", code, body, 409)
		code, body = complete(id, line(pid, nil))
		must("replay clearing a counted line", code, body, 409)
		if got := stockOf(pid); got != 10 {
			t.Fatalf("rejected replay changed stock: %d", got)
		}
		intp("actualQty kept", only(id).ActualQty, 14)
	})

	sub("13 value changed in the Complete payload after a per-line save drops the baseline (frozen fallback)", func(t *testing.T) {
		pid := newProduct(15)
		id := create(line(pid, nil))
		start(id)
		sell(pid, 3) // stock 12
		code, body := put(id, map[string]any{"items": []any{line(pid, 11)}})
		must("save line", code, body, 200)
		intp("baseline", only(id).BaselineQty, 12)
		code, body = complete(id, line(pid, 10))
		must("complete", code, body, 200)
		it := only(id)
		if it.BaselineQty != nil {
			t.Fatalf("changed value must drop the baseline: %+v", it)
		}
		// Documented behaviour: no baseline, so delta = 10 - frozen 15.
		if got := stockOf(pid); got != 7 {
			t.Fatalf("stock = %d, want 7 (12 + (10-15))", got)
		}
		intp("difference", it.Difference, -5)
	})

	sub("14 concurrent starts at one location leave exactly one in_progress", func(t *testing.T) {
		pid := newProduct(10)
		const n = 6
		ids := make([]string, n)
		for i := range ids {
			ids[i] = create(line(pid, nil))
		}
		codes := make([]int, n)
		var wg sync.WaitGroup
		for i := range ids {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				r := httptest.NewRequest("PUT", "/stock-counts/"+ids[i], strings.NewReader(`{"status":"in_progress"}`))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				codes[i] = w.Code
			}(i)
		}
		wg.Wait()
		ok, conflict := 0, 0
		for _, c := range codes {
			switch c {
			case 200:
				ok++
			case 409:
				conflict++
			}
		}
		if ok != 1 || conflict != n-1 {
			t.Fatalf("codes = %v, want one 200 and %d 409", codes, n-1)
		}
		if got := count(`SELECT count(*) FROM stock_counts WHERE outlet_id=$1 AND status='in_progress'`, outlet); got != 1 {
			t.Fatalf("in_progress counts = %d, want 1", got)
		}
		for i, c := range codes { // leave the location free for later cases
			if c == 200 {
				code, body := put(ids[i], map[string]any{"status": "cancelled"})
				must("cancel winner", code, body, 200)
			}
		}
	})

	sub("15 cancel racing complete: exactly one wins and stock stays consistent", func(t *testing.T) {
		for round := 0; round < 4; round++ {
			pid := newProduct(10)
			id := create(line(pid, nil))
			start(id)
			code, body := put(id, map[string]any{"items": []any{line(pid, 7)}})
			must("save line", code, body, 200)
			var cCode, xCode int
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				r := httptest.NewRequest("POST", "/stock-counts/"+id+"/complete", strings.NewReader(`{}`))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				cCode = w.Code
			}()
			go func() {
				defer wg.Done()
				r := httptest.NewRequest("PUT", "/stock-counts/"+id, strings.NewReader(`{"status":"cancelled"}`))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				xCode = w.Code
			}()
			wg.Wait()
			st, got := get(id).Status, stockOf(pid)
			switch {
			case cCode == 200 && xCode == 409 && st == "completed" && got == 7:
			case cCode == 409 && xCode == 200 && st == "cancelled" && got == 10:
			default:
				t.Fatalf("round %d: complete=%d cancel=%d status=%s stock=%d", round, cCode, xCode, st, got)
			}
		}
	})

	sub("16 start and items in one PUT: start first, then the lines are saved against the fresh baseline", func(t *testing.T) {
		pid := newProduct(10)
		id := create(line(pid, nil))
		sell(pid, 3) // planned, stock 7
		code, body := put(id, map[string]any{"status": "in_progress", "items": []any{line(pid, 6)}})
		must("start with items", code, body, 200)
		v := get(id)
		if v.Status != "in_progress" {
			t.Fatalf("status = %s", v.Status)
		}
		it := only(id)
		intp("frozen re-frozen", &it.FrozenQty, 7)
		intp("actual", it.ActualQty, 6)
		intp("baseline", it.BaselineQty, 7)
		code, body = complete(id)
		must("complete", code, body, 200)
		if got := stockOf(pid); got != 6 {
			t.Fatalf("stock = %d, want 6", got)
		}
		// On a planned count the items replace the list instead; no actual is stored.
		pid2 := newProduct(4)
		id2 := create(line(pid2, nil))
		code, body = put(id2, map[string]any{"items": []any{line(pid2, 1)}})
		must("planned replace", code, body, 200)
		if only(id2).ActualQty != nil {
			t.Fatal("a planned count must not store counted quantities")
		}
	})
}
