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
	router.With(authWrap, mw.RequirePermission("view_reports")).Get("/oversell-report", h.OversellReport)
	router.With(authWrap, mw.RequirePermission("view_reports")).Get("/oversell-report/open-count", h.OversellOpenCount)
	router.With(authWrap, mw.RequirePermission("manage_stock_count")).Post("/oversell-records/acknowledge", h.AcknowledgeOversell)
	adminTok := issue(admin, "admin", "", "view_reports", "manage_stock_count")
	cashier2 := issue(user2, "cashier", outlet2, "create_order", "view_reports")                       // no manage_stock_count
	auditor2 := issue(user2, "cashier", outlet2, "create_order", "view_reports", "manage_stock_count") // outlet-two auditor
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
			go func() {
				defer wg.Done()
				do(token, "POST", "/sync/batch", map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": "os-conc-3", "payload": cp}}}, "")
			}()
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

	// ---- report + acknowledge (Q1) ----
	type breakdown struct {
		Key       string `json:"key"`
		Lines     int    `json:"lines"`
		Shortfall int    `json:"shortfall"`
	}
	type reportOut struct {
		Summary struct {
			Lines, Orders, TotalShortfall, ActiveShortfall, ReversedShortfall, OpenCount int
			ByProduct, ByCashier                                                         []breakdown
		} `json:"summary"`
		Data []struct {
			ID, OrderNumber, OrderStatus, Kind, Channel, CashierName, VariantSize string
			Shortfall                                                             int
			StockBefore, StockAfter, CurrentStock                                 *int
			AcknowledgedAt                                                        *string
			AcknowledgedByName, AcknowledgeNote                                   *string
			SKU                                                                   *string `json:"sku"`
		} `json:"data"`
		Meta struct{ Total, Page, Limit int } `json:"meta"`
	}
	report := func(tk, query string) (int, reportOut) {
		cur.Helper()
		code, body := do(tk, "GET", "/oversell-report?"+query, nil, "")
		var out reportOut
		if code == 200 {
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				cur.Fatalf("decode: %v %s", err, body)
			}
		}
		return code, out
	}
	// outlet-two sale through its own cashier
	sellAt2 := func(key string, p map[string]any) {
		cur.Helper()
		delete(p, "shiftId") // the open shift belongs to outlet one
		if code, body := do(cashier2, "POST", "/orders", p, key); code != 201 && code != 200 {
			cur.Fatalf("outlet2 sale: %d %s", code, body)
		}
	}
	var rp string // report product, isolated from the earlier subtests
	var ids1 []string

	sub("7 report: filters, totals, scope clamp, pagination, refund split", func(t *testing.T) {
		rp = newProduct(0)
		direct("os-rep-a", payload(sale{rp, 2}))
		syncSale("os-rep-b", payload(sale{rp, 1}))
		sellAt2("os-rep-c", payload(sale{rp, 4}))

		code, all := report(adminTok, "outletId=all&productId="+rp)
		if code != 200 || all.Summary.Lines != 3 || all.Summary.Orders != 3 || all.Summary.TotalShortfall != 7 || all.Summary.ActiveShortfall != 7 ||
			all.Summary.ReversedShortfall != 0 || all.Summary.OpenCount != 3 || len(all.Summary.ByProduct) != 1 || len(all.Summary.ByCashier) != 2 ||
			all.Meta.Total != 3 || len(all.Data) != 3 {
			t.Fatalf("admin all: %d %+v", code, all)
		}
		if all.Data[0].SKU == nil || *all.Data[0].SKU == "" || all.Data[0].CurrentStock == nil || *all.Data[0].CurrentStock >= 0 {
			t.Fatalf("display fields: %+v", all.Data[0])
		}
		_, one := report(adminTok, "outletId="+outlet+"&productId="+rp)
		if one.Summary.Lines != 2 || one.Summary.TotalShortfall != 3 {
			t.Fatalf("admin outlet one: %+v", one.Summary)
		}
		// scope clamp: a non-admin naming another outlet still gets only their own.
		_, clamped := report(cashier2, "outletId="+outlet+"&productId="+rp)
		if clamped.Summary.Lines != 1 || clamped.Summary.TotalShortfall != 4 || len(clamped.Data) != 1 {
			t.Fatalf("scope clamp leaked: %+v", clamped.Summary)
		}
		// pagination meta
		_, pg := report(adminTok, "outletId=all&productId="+rp+"&limit=1&page=2")
		if pg.Meta.Total != 3 || pg.Meta.Page != 2 || pg.Meta.Limit != 1 || len(pg.Data) != 1 {
			t.Fatalf("pagination: %+v", pg.Meta)
		}
		// filters that match nothing, and invalid input
		if _, none := report(adminTok, "outletId=all&productId="+rp+"&kind=unresolved_variant"); none.Summary.Lines != 0 || len(none.Data) != 0 {
			t.Fatalf("kind filter: %+v", none.Summary)
		}
		if _, none := report(adminTok, "outletId=all&productId="+rp+"&dateFrom=2999-01-01"); none.Summary.Lines != 0 {
			t.Fatalf("date filter: %+v", none.Summary)
		}
		if _, day := report(adminTok, "outletId=all&productId="+rp+"&dateFrom=2000-01-01&dateTo=2999-01-01"); day.Summary.Lines != 3 {
			t.Fatalf("date range: %+v", day.Summary)
		}
		for _, bad := range []string{"dateFrom=garbage", "kind=nope", "status=nope", "productId=not-a-uuid", "cashierId=x"} {
			if c, _ := report(adminTok, bad); c != 400 {
				t.Fatalf("%s -> %d, want 400", bad, c)
			}
		}
		if c, _ := report(token, ""); c != 403 { // create_order/process_refund only: no view_reports
			t.Fatalf("no view_reports -> %d, want 403", c)
		}
		// refund the first sale: its shortfall moves from active to reversed.
		id := count2(t, pool, ctx, `SELECT id::text FROM orders WHERE idempotency_key='os-rep-a'`)
		if c, body := do(token, "POST", "/orders/"+id+"/refund", map[string]any{"reason": "salah"}, ""); c != 200 && c != 201 {
			t.Fatalf("refund %d %s", c, body)
		}
		_, split := report(adminTok, "outletId=all&productId="+rp)
		if split.Summary.ActiveShortfall != 5 || split.Summary.ReversedShortfall != 2 || split.Summary.TotalShortfall != 7 {
			t.Fatalf("refund split: %+v", split.Summary)
		}
		for _, d := range split.Data {
			ids1 = append(ids1, d.ID)
		}
	})

	sub("8 acknowledge: permission, scope, idempotence, validation, badge count", func(t *testing.T) {
		openCount := func(tk string) int {
			t.Helper()
			code, body := do(tk, "GET", "/oversell-report/open-count", nil, "")
			var out struct {
				Data struct {
					OpenCount int `json:"openCount"`
				} `json:"data"`
			}
			if code != 200 || json.Unmarshal([]byte(body), &out) != nil {
				t.Fatalf("open-count %d %s", code, body)
			}
			return out.Data.OpenCount
		}
		_, two := report(adminTok, "outletId="+outlet2+"&productId="+rp)
		_, one := report(adminTok, "outletId="+outlet+"&productId="+rp)
		if len(two.Data) != 1 || len(one.Data) != 2 {
			t.Fatalf("setup: two=%d one=%d", len(two.Data), len(one.Data))
		}
		before2 := openCount(cashier2)
		if c, _ := do(cashier2, "POST", "/oversell-records/acknowledge", map[string]any{"ids": []string{two.Data[0].ID}}, ""); c != 403 {
			t.Fatalf("ack without manage_stock_count -> %d, want 403", c)
		}
		// an outlet-two auditor cannot touch an outlet-one line (out of scope: skipped, not an error)
		code, body := do(auditor2, "POST", "/oversell-records/acknowledge", map[string]any{"ids": []string{one.Data[0].ID}}, "")
		if code != 200 || !strings.Contains(body, `"acknowledged":0`) {
			t.Fatalf("cross-outlet ack: %d %s", code, body)
		}
		if count(`SELECT count(*) FROM sale_stock_exceptions WHERE id=$1::uuid AND acknowledged_at IS NULL`, one.Data[0].ID) != 1 {
			t.Fatal("cross-outlet line was acknowledged")
		}
		// own line, with a note
		code, body = do(auditor2, "POST", "/oversell-records/acknowledge", map[string]any{"ids": []string{two.Data[0].ID}, "note": "  botol ada di rak, salah hitung  "}, "")
		if code != 200 || !strings.Contains(body, `"acknowledged":1`) {
			t.Fatalf("own ack: %d %s", code, body)
		}
		if openCount(cashier2) != before2-1 {
			t.Fatalf("badge did not drop: %d -> %d", before2, openCount(cashier2))
		}
		// repeat is a no-op and keeps the first acknowledgement
		code, body = do(auditor2, "POST", "/oversell-records/acknowledge", map[string]any{"ids": []string{two.Data[0].ID}, "note": "lain"}, "")
		if code != 200 || !strings.Contains(body, `"acknowledged":0`) {
			t.Fatalf("repeat ack: %d %s", code, body)
		}
		_, after := report(adminTok, "outletId="+outlet2+"&productId="+rp+"&status=acknowledged")
		d := after.Data
		if len(d) != 1 || d[0].AcknowledgedAt == nil || d[0].AcknowledgedByName == nil || *d[0].AcknowledgedByName != "OS cashier two" ||
			d[0].AcknowledgeNote == nil || *d[0].AcknowledgeNote != "botol ada di rak, salah hitung" {
			t.Fatalf("ack fields: %+v", d)
		}
		// validation: unknown field, empty ids, bad uuid, over-long note, too many ids
		tooMany := make([]string, 201)
		for i := range tooMany {
			tooMany[i] = "00000000-0000-4000-8f99-000000000001"
		}
		for name, b := range map[string]any{
			"unknown field": map[string]any{"ids": []string{one.Data[0].ID}, "extra": 1},
			"empty ids":     map[string]any{"ids": []string{}},
			"bad uuid":      map[string]any{"ids": []string{"nope"}},
			"long note":     map[string]any{"ids": []string{one.Data[0].ID}, "note": strings.Repeat("x", 501)},
			"too many ids":  map[string]any{"ids": tooMany},
		} {
			if c, _ := do(adminTok, "POST", "/oversell-records/acknowledge", b, ""); c != 400 {
				t.Fatalf("%s -> %d, want 400", name, c)
			}
		}
		// admin acknowledges the rest of this product (cross-all scope)
		code, body = do(adminTok, "POST", "/oversell-records/acknowledge", map[string]any{"ids": ids1}, "")
		if code != 200 || !strings.Contains(body, `"acknowledged":2`) {
			t.Fatalf("admin ack: %d %s", code, body)
		}
		if _, open := report(adminTok, "outletId=all&productId="+rp+"&status=open"); open.Summary.Lines != 0 || open.Summary.OpenCount != 0 {
			t.Fatalf("still open: %+v", open.Summary)
		}
		if openCount(adminTok) < 1 { // other subtests' lines are still unchecked
			t.Fatalf("admin badge = %d", openCount(adminTok))
		}
	})

	// ---- phase 4: unresolved variants and the refund restock guard ----
	// Variants are hard-deleted in production (write/repo.go removes the variant and
	// its stock rows), so the fixture deletes them the same way.
	dropVariant := func(pid string) {
		cur.Helper()
		exec(`DELETE FROM outlet_variant_stock WHERE product_id=$1`, pid)
		exec(`DELETE FROM product_variants WHERE product_id=$1`, pid)
	}
	refundOK := func(orderID string) {
		cur.Helper()
		if c, body := do(token, "POST", "/orders/"+orderID+"/refund", map[string]any{"reason": "uji"}, ""); c != 200 && c != 201 {
			cur.Fatalf("refund %d %s", c, body)
		}
	}
	kindCount := func(orderID, kind string) int {
		cur.Helper()
		return count(`SELECT count(*) FROM sale_stock_exceptions WHERE order_id=$1 AND kind=$2`, orderID, kind)
	}
	stockRows := func(pid string) int {
		cur.Helper()
		return count(`SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1`, pid)
	}

	sub("9 a variant deleted before the sale: the line is recorded, no stock is invented, refund restocks nothing", func(t *testing.T) {
		pid := newProduct(3)
		dropVariant(pid)
		id := direct("os-p4-sale", payload(sale{pid, 2}))
		if stockRows(pid) != 0 || kindCount(id, "unresolved_variant") != 1 {
			t.Fatalf("stock rows=%d unresolved rows=%d", stockRows(pid), kindCount(id, "unresolved_variant"))
		}
		var before, after *int
		var short, qty int
		if err := pool.QueryRow(ctx, `SELECT stock_before, stock_after, shortfall, quantity FROM sale_stock_exceptions WHERE order_id=$1`, id).Scan(&before, &after, &short, &qty); err != nil {
			t.Fatal(err)
		}
		if before != nil || after != nil || short != 2 || qty != 2 {
			t.Fatalf("unresolved row: before=%v after=%v short=%d qty=%d", before, after, short, qty)
		}
		if count(`SELECT count(*) FROM orders WHERE id=$1 AND stock_warning`, id) != 1 {
			t.Fatal("an unresolved-variant sale must set orders.stock_warning")
		}
		// the report counts the line but a missing variant is not extra shortfall
		if _, rep := report(adminTok, "outletId=all&productId="+pid); rep.Summary.Lines != 1 || rep.Summary.TotalShortfall != 0 ||
			rep.Summary.ActiveShortfall != 0 || rep.Summary.ReversedShortfall != 0 {
			t.Fatalf("unresolved line leaked into shortfall totals: %+v", rep.Summary)
		} else {
			for _, b := range append(append([]breakdown{}, rep.Summary.ByProduct...), rep.Summary.ByCashier...) {
				if b.Lines != 1 || b.Shortfall != 0 {
					t.Fatalf("unresolved line leaked into breakdown shortfall: %+v", b)
				}
			}
			if len(rep.Summary.ByProduct) != 1 || len(rep.Summary.ByCashier) != 1 {
				t.Fatalf("expected one breakdown row each, got %+v", rep.Summary)
			}
		}
		refundOK(id)
		if count(`SELECT count(*) FROM orders WHERE id=$1 AND stock_warning`, id) != 1 {
			t.Fatal("refund must not touch orders.stock_warning")
		}
		if stockRows(pid) != 0 || kindCount(id, "refund_unresolved_variant") != 0 {
			t.Fatalf("refund created phantom stock: rows=%d refund-side=%d", stockRows(pid), kindCount(id, "refund_unresolved_variant"))
		}
		// a late offline sync of a deleted variant is recorded the same way
		pid2 := newProduct(3)
		dropVariant(pid2)
		if st := syncSale("os-p4-sync", payload(sale{pid2, 1})); st != "ok" {
			t.Fatalf("sync status %s", st)
		}
		if exceptions("os-p4-sync") != 1 || stockRows(pid2) != 0 ||
			count(`SELECT count(*) FROM orders WHERE idempotency_key='os-p4-sync' AND stock_warning`) != 1 {
			t.Fatalf("sync unresolved rows=%d stock rows=%d", exceptions("os-p4-sync"), stockRows(pid2))
		}
	})

	sub("10 a variant deleted after the sale: refund succeeds, restocks nothing, records the skipped line", func(t *testing.T) {
		pid := newProduct(5)
		id := direct("os-p4-after", payload(sale{pid, 1}))
		if exceptions("os-p4-after") != 0 || stockOf(pid) != 4 {
			t.Fatalf("setup: rows=%d stock=%d", exceptions("os-p4-after"), stockOf(pid))
		}
		dropVariant(pid)
		refundOK(id)
		if stockRows(pid) != 0 {
			t.Fatalf("orphan stock row recreated: %d", stockRows(pid))
		}
		var short int
		var channel string
		if err := pool.QueryRow(ctx, `SELECT shortfall, channel FROM sale_stock_exceptions WHERE order_id=$1 AND kind='refund_unresolved_variant'`, id).Scan(&short, &channel); err != nil {
			t.Fatalf("refund-side row: %v", err)
		}
		if short != 1 || channel != "direct" {
			t.Fatalf("refund-side row: shortfall=%d channel=%s", short, channel)
		}
		// a whole product deleted after the sale used to fail the refund on the stock FK
		pid2 := newProduct(5)
		id2 := direct("os-p4-product", payload(sale{pid2, 1}))
		exec(`DELETE FROM products WHERE id=$1`, pid2)
		refundOK(id2)
		if kindCount(id2, "refund_unresolved_variant") != 1 || count(`SELECT count(*) FROM orders WHERE id=$1 AND status='refunded'`, id2) != 1 {
			t.Fatal("refund of a deleted product did not complete and record")
		}
	})

	sub("12 a bundle line whose variant and stock row are gone: refund restocks nothing and records nothing", func(t *testing.T) {
		pid := newProduct(5)
		p := payload(sale{pid, 1})
		p["items"].([]map[string]any)[0]["isBundle"] = true
		id := direct("os-p4-bundle", p)
		dropVariant(pid)
		refundOK(id)
		if stockRows(pid) != 0 || count(`SELECT count(*) FROM sale_stock_exceptions WHERE order_id=$1`, id) != 0 ||
			count(`SELECT count(*) FROM orders WHERE id=$1 AND status='refunded'`, id) != 1 {
			t.Fatalf("bundle refund: stock rows=%d exceptions=%d", stockRows(pid), count(`SELECT count(*) FROM sale_stock_exceptions WHERE order_id=$1`, id))
		}
	})

	sub("11 a normal refund still restocks exactly what the sale took", func(t *testing.T) {
		pid := newProduct(5)
		id := direct("os-p4-normal", payload(sale{pid, 2}))
		refundOK(id)
		if stockOf(pid) != 5 || kindCount(id, "refund_unresolved_variant") != 0 {
			t.Fatalf("stock=%d", stockOf(pid))
		}
	})
}

func count2(t *testing.T, pool *pgxpool.Pool, ctx context.Context, sql string, args ...any) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}
