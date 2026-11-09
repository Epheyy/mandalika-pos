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

// A28 per-outlet timezone and business date. Opt-in only, same isolation contract as the
// other gates. Every sales read filters on the stored business_date (the day in the OUTLET's
// zone; a shift's sales take the shift's opening date); migration 0059 stamps it by trigger.
func TestBusinessDatePostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_BD_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 26462 || cfg.ConnConfig.Database != "mandalika_bd_synthetic" || cfg.ConnConfig.User != "bd_test" {
		t.Fatal("refusing non-fixture target")
	}
	// Pin the session zone so a server-zone dependence cannot hide; the fix must not rely on it.
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
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
	expected := os.Getenv("MANDALIKA_BD_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	// Case 7a: the migration applies whole through db.go (proves the $$ function bodies).
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
	str := func(sql string, args ...any) string {
		cur.Helper()
		var s *string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			cur.Fatalf("%s: %v", sql, err)
		}
		if s == nil {
			return "<null>"
		}
		return *s
	}
	const (
		outW    = "00000000-0000-4000-8b00-000000000001" // Asia/Jakarta (column default)
		outM    = "00000000-0000-4000-8b00-000000000002" // Asia/Makassar
		userW   = "00000000-0000-4000-8b00-000000000011"
		adminU  = "00000000-0000-4000-8b00-000000000012"
		product = "00000000-0000-4000-8b00-000000000021"
		device  = "bddev"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'BD Jakarta')`, outW)
	exec(`INSERT INTO outlets(id,name,timezone) VALUES($1,'BD Makassar','Asia/Makassar')`, outM)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'w@example.invalid','x','BD cashier','cashier',$2)`, userW, outW)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'a@example.invalid','x','BD admin','admin')`, adminU)
	exec(`INSERT INTO products(id,name) VALUES($1,'BD product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'BD')`, product)
	for _, o := range []string{outW, outM} {
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, o, product)
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("BD-INTEGRATION-SYNTHETIC-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, []string{"create_order", "process_refund", "view_reports"})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokAdmin, tokW := issue(adminU, "admin", ""), issue(userW, "cashier", outW)
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/orders", h.Orders)
	router.With(authWrap).Get("/shifts", h.Shifts)
	router.With(authWrap).Get("/reports/summary", h.ReportSummary)
	router.With(authWrap).Get("/oversell-report", h.OversellReport)
	router.With(authWrap).Get("/promo-reward-grants", h.PromoRewardGrants)
	router.With(authWrap).Get("/discount-code-report", h.DiscountCodeReport)
	router.With(authWrap).Post("/outlets", h.CreateOutlet)
	router.With(authWrap).Put("/outlets/{id}", h.UpdateOutlet)
	router.With(authWrap).Post("/orders/{id}/refund", h.RefundOrder)
	if _, err = h.Sync.Version(ctx, outW); err != nil {
		t.Fatal(err)
	}
	call := func(token, method, path string, body any) (int, map[string]any) {
		cur.Helper()
		rdr := bytes.NewReader(nil)
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	get := func(token, path string) map[string]any {
		cur.Helper()
		code, out := call(token, "GET", path, nil)
		if code != http.StatusOK {
			cur.Fatalf("GET %s -> %d %v", path, code, out)
		}
		return out
	}
	seq := 0
	// order inserts a shift-less or shift-attached sale straight into the table. It omits the
	// business-date columns on purpose: the triggers must fill them.
	order := func(key, outlet, shift string, amount int, created, client string) string {
		cur.Helper()
		seq++
		id := fmt.Sprintf("00000000-0000-4000-8b01-%012d", seq)
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at,shift_id,client_created_at)
			VALUES($1,$1,$2,$2,$3,$4,'BD',$5,$5,'cash','completed',$6,NULLIF($7,'')::uuid,NULLIF($8,'')::timestamptz)`, id, key, outlet, userW, amount, created, shift, client)
		return id
	}
	bd := func(key string) string {
		cur.Helper()
		return str(`SELECT business_date::text FROM orders WHERE idempotency_key=$1`, key)
	}
	summary := func(token, query string) map[string]any {
		return get(token, "/reports/summary?"+query)["data"].(map[string]any)
	}
	dailyDates := func(s map[string]any) string {
		var parts []string
		for _, d := range s["dailySales"].([]any) {
			m := d.(map[string]any)
			parts = append(parts, fmt.Sprintf("%v=%v", m["date"], m["sales"]))
		}
		return strings.Join(parts, ",")
	}
	var shiftOpenM, shiftClosedW, shiftLateW string

	sub("1 WITA boundary: a shift-less sale takes the day in its outlet's zone", func(t *testing.T) {
		order("w-1645", outW, "", 100, "2026-10-19T16:45:00Z", "")
		order("m-1645", outM, "", 200, "2026-10-19T16:45:00Z", "")
		order("w-1715", outW, "", 400, "2026-10-19T17:15:00Z", "")
		order("m-1715", outM, "", 800, "2026-10-19T17:15:00Z", "")
		for key, want := range map[string]string{"w-1645": "2026-10-19", "m-1645": "2026-10-20", "w-1715": "2026-10-20", "m-1715": "2026-10-20"} {
			if got := bd(key); got != want {
				t.Errorf("%s business_date=%s want %s", key, got, want)
			}
		}
		// Cross-outlet report for 10-19 as admin includes the Jakarta row and excludes the Makassar row.
		s := summary(tokAdmin, "dateFrom=2026-10-19&dateTo=2026-10-19&outletId=all")
		if s["totalSales"] != float64(100) || s["totalOrders"] != float64(1) {
			t.Errorf("summary 10-19: %v", s)
		}
		if got := dailyDates(s); got != "2026-10-19=100" {
			t.Errorf("dailySales: %q", got)
		}
		if s["dateFrom"] != "2026-10-19" || s["dateTo"] != "2026-10-19" {
			t.Errorf("summary must echo the business days: %v %v", s["dateFrom"], s["dateTo"])
		}
		list := get(tokAdmin, "/orders?dateFrom=2026-10-19&dateTo=2026-10-19&outletId=all")
		if n := len(list["data"].([]any)); n != 1 {
			t.Errorf("/orders 10-19 rows=%d want 1", n)
		}
		s = summary(tokAdmin, "dateFrom=2026-10-20&dateTo=2026-10-20&outletId=all")
		if s["totalSales"] != float64(1400) {
			t.Errorf("summary 10-20: %v", s["totalSales"])
		}
		// A shift opened 23:30 WITA 10-19 (15:30Z) keeps a 00:15 WITA 10-20 sale on 10-19.
		shiftOpenM = "00000000-0000-4000-8b02-000000000001"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'BD','open','2026-10-19T15:30:00Z',0)`, shiftOpenM, outM, userW)
		if got := str(`SELECT business_date::text FROM shifts WHERE id=$1`, shiftOpenM); got != "2026-10-19" {
			t.Errorf("shift business_date=%s", got)
		}
		order("m-shift", outM, shiftOpenM, 50, "2026-10-19T16:15:00Z", "")
		if got := bd("m-shift"); got != "2026-10-19" {
			t.Errorf("sale on a shift opened the previous day: business_date=%s want 2026-10-19", got)
		}
	})

	batch := func(name string, payload map[string]any, env map[string]any) string {
		cur.Helper()
		item := map[string]any{"type": "order", "idempotencyKey": device + ":" + name, "payload": payload, "envelope": env}
		code, out := call(tokW, "POST", "/sync/batch", map[string]any{"items": []any{item}})
		if code != 200 {
			cur.Fatalf("batch %d %v", code, out)
		}
		res := out["data"].(map[string]any)["results"].([]any)[0].(map[string]any)
		if res["status"] != "ok" {
			cur.Fatalf("batch item %s: %v", name, res)
		}
		return device + ":" + name
	}
	envelope := func(shift string) map[string]any {
		e := map[string]any{"v": 1, "outletId": outW, "userId": userW, "deviceId": device, "capturedAt": time.Now().UTC().Format(time.RFC3339)}
		if shift != "" {
			e["shiftId"] = shift
		}
		return e
	}
	payload := func(extra map[string]any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8b03-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "BD product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}

	sub("2 an offline sale synced days later keeps its closed shift's day", func(t *testing.T) {
		// The shift is a week old; the sale syncs now. A stamp taken from created_at (the sync day)
		// would differ from the shift's day, so this fails unless the shift's date is used.
		shiftClosedW = "00000000-0000-4000-8b02-000000000002"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,closed_at,starting_cash) VALUES($1,$2,$3,'BD','closed','2026-10-12T01:00:00Z','2026-10-12T15:00:00Z',0)`, shiftClosedW, outW, userW)
		shiftCols := `SELECT concat_ws('|',status,total_sales,total_orders,total_refunds,cash_sales,closing_cash) FROM shifts WHERE id=$1`
		shiftBefore := str(shiftCols, shiftClosedW)
		key := batch("late-closed", payload(map[string]any{"shiftId": shiftClosedW, "clientCreatedAt": "2026-10-14T05:00:00Z"}), envelope(shiftClosedW))
		// The device time is on 10-14 (never the shift's day), so only the stored shift id can give 10-12.
		if got := str(`SELECT shift_id::text FROM orders WHERE idempotency_key=$1`, key); got != shiftClosedW {
			t.Fatalf("sync must keep the closed shift id on the order, got %s", got)
		}
		if got := bd(key); got != "2026-10-12" {
			t.Fatalf("late sale on a closed shift: business_date=%s want 2026-10-12", got)
		}
		syncDay := str(`SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date::text FROM orders WHERE idempotency_key=$1`, key)
		if syncDay == "2026-10-12" {
			t.Fatalf("test needs a sync day different from the shift day, got %s", syncDay)
		}
		id := str(`SELECT id::text FROM orders WHERE idempotency_key=$1`, key)
		has := func(day string) bool {
			for _, o := range get(tokAdmin, "/orders?dateFrom="+day+"&dateTo="+day+"&outletId="+outW)["data"].([]any) {
				if o.(map[string]any)["id"] == id {
					return true
				}
			}
			return false
		}
		if !has("2026-10-12") {
			t.Error("the late sale must be listed on the shift's day")
		}
		if has(syncDay) {
			t.Errorf("the late sale must be absent from the day it synced (%s)", syncDay)
		}
		s := summary(tokAdmin, "dateFrom=2026-10-12&dateTo=2026-10-12&outletId="+outW)
		if s["totalSales"] != float64(100000) || dailyDates(s) != "2026-10-12=100000" {
			t.Errorf("summary on the shift's day: %v / %s", s["totalSales"], dailyDates(s))
		}
		if shiftAfter := str(shiftCols, shiftClosedW); shiftAfter != shiftBefore {
			t.Errorf("closed shift totals changed: %s -> %s", shiftBefore, shiftAfter)
		}
	})

	sub("3 a shift-less late sale uses clamped device time in the outlet zone", func(t *testing.T) {
		now := time.Now().UTC()
		ok := now.Add(-36 * time.Hour)
		key := batch("late-client", payload(map[string]any{"clientCreatedAt": ok.Format(time.RFC3339)}), envelope(""))
		want := ok.In(time.FixedZone("WIB", 7*3600)).Format("2006-01-02")
		if got := bd(key); got != want {
			t.Errorf("in-window client time: business_date=%s want %s", got, want)
		}
		for name, c := range map[string]time.Time{"future": now.Add(time.Hour), "ancient": now.Add(-30 * 24 * time.Hour)} {
			k := batch("late-"+name, payload(map[string]any{"clientCreatedAt": c.Format(time.RFC3339)}), envelope(""))
			wantCreated := str(`SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date::text FROM orders WHERE idempotency_key=$1`, k)
			if got := bd(k); got != wantCreated {
				t.Errorf("%s client clock: business_date=%s want created_at day %s", name, got, wantCreated)
			}
		}
	})

	sub("4 a refund stamps its own business date and leaves the sale's alone", func(t *testing.T) {
		shiftLateW = "00000000-0000-4000-8b02-000000000003"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'BD','open','2026-10-21T02:00:00Z',0)`, shiftLateW, outW, userW)
		before := bd("w-1645")
		exec(`UPDATE orders SET status='refunded',refunded_at='2026-10-21T03:00:00Z',refund_shift_id=$1 WHERE idempotency_key='w-1645'`, shiftLateW)
		if got := str(`SELECT refund_business_date::text FROM orders WHERE idempotency_key='w-1645'`); got != "2026-10-21" {
			t.Errorf("POS refund on a shift opened 10-21: refund_business_date=%s", got)
		}
		// Backoffice refund (no shift) at 16:50Z is 00:50 WITA 10-20 at the Makassar outlet.
		exec(`UPDATE orders SET status='refunded',refunded_at='2026-10-19T16:50:00Z' WHERE idempotency_key='m-1645'`)
		if got := str(`SELECT refund_business_date::text FROM orders WHERE idempotency_key='m-1645'`); got != "2026-10-20" {
			t.Errorf("shift-less refund at the WITA outlet: refund_business_date=%s want 2026-10-20", got)
		}
		if got := bd("w-1645"); got != before {
			t.Errorf("refund changed the sale's business_date: %s -> %s", before, got)
		}
		if got := str(`SELECT refund_business_date::text FROM orders WHERE idempotency_key='w-1715'`); got != "<null>" {
			t.Errorf("an unrefunded sale must have no refund date: %s", got)
		}
		// A row inserted already refunded (import path) is stamped by the INSERT trigger.
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,created_at,refunded_at)
			VALUES('00000000-0000-4000-8b01-000000009001','00000000-0000-4000-8b01-000000009001','m-ins-ref','m-ins-ref',$1,$2,'BD',5,5,'cash','refunded','2026-10-18T03:00:00Z','2026-10-19T16:50:00Z')`, outM, userW)
		if got := str(`SELECT refund_business_date::text FROM orders WHERE idempotency_key='m-ins-ref'`); got != "2026-10-20" {
			t.Errorf("insert-as-refunded at the WITA outlet: refund_business_date=%s want 2026-10-20", got)
		}
		// The real refund route stamps it too.
		id := order("w-refund-route", outW, "", 10, "2026-10-19T03:00:00Z", "")
		if code, out := call(tokW, "POST", "/orders/"+id+"/refund", map[string]string{"reason": "rusak"}); code != 201 {
			t.Fatalf("refund route %d %v", code, out)
		}
		if got := str(`SELECT refund_business_date::text FROM orders WHERE id=$1`, id); got == "<null>" {
			t.Error("refund route left refund_business_date NULL")
		}
		// Putting the sale back so later cases keep their numbers.
		exec(`UPDATE orders SET status='completed',refunded_at=NULL,refund_shift_id=NULL WHERE idempotency_key IN ('w-1645','m-1645')`)
	})

	sub("5 outlet timezone: default, keep on update, validation, CHECK, history frozen", func(t *testing.T) {
		code, out := call(tokAdmin, "POST", "/outlets", map[string]any{"name": "BD new", "isActive": true})
		if code != 201 {
			t.Fatalf("create %d %v", code, out)
		}
		newID := out["data"].(map[string]any)["id"].(string)
		if got := str(`SELECT timezone FROM outlets WHERE id=$1`, newID); got != "Asia/Jakarta" {
			t.Errorf("create without timezone: %s", got)
		}
		if code, out = call(tokAdmin, "PUT", "/outlets/"+outM, map[string]any{"name": "BD Makassar", "isActive": true}); code != 200 {
			t.Fatalf("update %d %v", code, out)
		}
		if got := str(`SELECT timezone FROM outlets WHERE id=$1`, outM); got != "Asia/Makassar" {
			t.Errorf("update without timezone must keep it: %s", got)
		}
		if code, _ = call(tokAdmin, "PUT", "/outlets/"+outM, map[string]any{"name": "BD Makassar", "isActive": true, "timezone": "Europe/London"}); code != 400 {
			t.Errorf("Europe/London must be 400, got %d", code)
		}
		if code, _ = call(tokAdmin, "POST", "/outlets", map[string]any{"name": "BD bad", "timezone": "Mars/Base"}); code != 400 {
			t.Errorf("bad timezone on create must be 400, got %d", code)
		}
		if _, err := pool.Exec(ctx, `UPDATE outlets SET timezone='Europe/London' WHERE id=$1`, outM); err == nil {
			t.Error("the CHECK constraint must reject a timezone outside the allowed set")
		}
		before := bd("m-1645")
		if code, out = call(tokAdmin, "PUT", "/outlets/"+outM, map[string]any{"name": "BD Makassar", "isActive": true, "timezone": "Asia/Jakarta"}); code != 200 {
			t.Fatalf("switch %d %v", code, out)
		}
		if got := bd("m-1645"); got != before {
			t.Errorf("editing the zone rewrote history: %s -> %s", before, got)
		}
		if code, _ = call(tokAdmin, "PUT", "/outlets/"+outM, map[string]any{"name": "BD Makassar", "isActive": true, "timezone": "Asia/Makassar"}); code != 200 {
			t.Fatal("switch back failed")
		}
	})

	sub("6 every report filters on the stored business date and keeps its scope", func(t *testing.T) {
		// Late-evening WIB sale at the Jakarta outlet is 10-20 (17:15Z) although its created_at,
		// sold_at and grant time are all on 10-19 UTC: the report must follow business_date.
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key='w-1715'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE orders SET discount_breakdown='[{"label":"BD10","amount":5}]'::jsonb WHERE id=$1`, id)
		var itemID string
		if err := pool.QueryRow(ctx, `INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'BD product','110ml',400,1,400) RETURNING id::text`, id, product).Scan(&itemID); err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO sale_stock_exceptions(order_id,order_item_id,order_number,outlet_id,product_id,product_name,variant_size,kind,quantity,stock_before,stock_after,shortfall,channel,cashier_id,cashier_name,sold_at)
			VALUES($1,$2,'w-1715',$3,$4,'BD product','110ml','shortage',1,0,-1,1,'sync',$5,'BD','2026-10-19T08:00:00Z')`, id, itemID, outW, product, userW)
		promo := "00000000-0000-4000-8b04-000000000001"
		exec(`INSERT INTO promotions(id,name,type,value) VALUES($1,'BD promo','fixed',0)`, promo)
		exec(`INSERT INTO discount_codes(code,promotion_id,type,value) VALUES('BD10',$1,'fixed',5)`, promo)
		exec(`INSERT INTO promo_reward_grants(order_id,promotion_id,product_id,product_name,variant_size,full_price,reward_price,reward_value,created_at)
			VALUES($1,$2,$3,'BD product','110ml',100,0,100,'2026-10-19T08:00:00Z')`, id, promo, product)
		total := func(m map[string]any) float64 {
			meta, _ := m["meta"].(map[string]any)
			v, _ := meta["total"].(float64)
			return v
		}
		for _, c := range []struct{ name, path string }{
			{"oversell", "/oversell-report?outletId=" + outW},
			{"grants", "/promo-reward-grants?outletId=" + outW},
			{"codes", "/discount-code-report?outletId=" + outW},
		} {
			if n := total(get(tokAdmin, c.path+"&dateFrom=2026-10-20&dateTo=2026-10-20")); n != 1 {
				t.Errorf("%s on the business day 10-20: total=%v want 1", c.name, n)
			}
			if n := total(get(tokAdmin, c.path+"&dateFrom=2026-10-19&dateTo=2026-10-19")); n != 0 {
				t.Errorf("%s on 10-19: total=%v want 0 (the sale's business day is 10-20)", c.name, n)
			}
		}
		for _, p := range []string{"/promo-reward-grants?dateFrom=bad", "/discount-code-report?dateTo=2026-13-45"} {
			if code, _ := call(tokAdmin, "GET", p, nil); code != http.StatusBadRequest {
				t.Errorf("%s must be 400, got %d", p, code)
			}
		}
		// /shifts follows the shift's business date: opened 17:30Z is 00:30 WIB 10-20.
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES('00000000-0000-4000-8b02-000000000004',$1,$2,'BD','closed','2026-10-19T17:30:00Z',0)`, outW, userW)
		exec(`UPDATE shifts SET closed_at='2026-10-19T18:30:00Z' WHERE id='00000000-0000-4000-8b02-000000000004'`)
		if n := len(get(tokAdmin, "/shifts?outletId=all&dateFrom=2026-10-20&dateTo=2026-10-20")["data"].([]any)); n != 1 {
			t.Errorf("/shifts 10-20 rows=%d want 1", n)
		}
		// Scope: a cashier cannot widen the outlet through the query.
		s := summary(tokW, "dateFrom=2026-10-20&dateTo=2026-10-20&outletId="+outM)
		ownOnly := str(`SELECT COALESCE(sum(total),0)::float8::text FROM orders WHERE outlet_id=$1 AND status='completed' AND business_date='2026-10-20'`, outW)
		if fmt.Sprint(s["totalSales"]) != ownOnly || ownOnly == "0" {
			t.Errorf("cashier scope leaked another outlet: summary %v, own outlet %s", s["totalSales"], ownOnly)
		}
	})

	sub("6b code report treats usage_limit NULL or 0 as unlimited", func(t *testing.T) {
		// Same order/promo as case 6; one breakdown component per code so each gets a row.
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key='w-1715'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		promo := "00000000-0000-4000-8b04-000000000001"
		exec(`INSERT INTO discount_codes(code,promotion_id,type,value,usage_limit,usage_count) VALUES
			('QZERO',$1,'fixed',5,0,3),('QFULL',$1,'fixed',5,5,5),('QNULL',$1,'fixed',5,NULL,2),('QLEFT',$1,'fixed',5,5,2)`, promo)
		exec(`UPDATE orders SET discount_breakdown='[{"label":"QZERO","amount":1},{"label":"QFULL","amount":1},{"label":"QNULL","amount":1},{"label":"QLEFT","amount":1}]'::jsonb WHERE id=$1`, id)
		rows, _ := get(tokAdmin, "/discount-code-report?outletId="+outW+"&dateFrom=2026-10-20&dateTo=2026-10-20")["data"].([]any)
		type want struct {
			status    string
			remaining any
		}
		wants := map[string]want{
			"QZERO": {"aktif", nil},
			"QFULL": {"kuota habis", float64(0)},
			"QNULL": {"aktif", nil},
			"QLEFT": {"aktif", float64(3)},
		}
		seen := 0
		for _, r := range rows {
			m, _ := r.(map[string]any)
			w, ok := wants[fmt.Sprint(m["code"])]
			if !ok {
				continue
			}
			seen++
			if m["status"] != w.status || m["remaining"] != w.remaining {
				t.Errorf("%v: status=%v remaining=%v want %s/%v", m["code"], m["status"], m["remaining"], w.status, w.remaining)
			}
		}
		if seen != len(wants) {
			t.Errorf("saw %d of %d seeded codes in the report", seen, len(wants))
		}
		// Leave case 6's state as the later cases expect it.
		exec(`UPDATE orders SET discount_breakdown='[{"label":"BD10","amount":5}]'::jsonb WHERE id=$1`, id)
	})

	sub("6c code report ignores orders whose discount_breakdown is jsonb null", func(t *testing.T) {
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key='w-1715'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		// Every other order gets a jsonb null (not SQL NULL); w-1715 keeps a real array.
		exec(`UPDATE orders SET discount_breakdown='null'::jsonb WHERE id<>$1 AND discount_breakdown IS NULL`, id)
		defer exec(`UPDATE orders SET discount_breakdown=NULL WHERE discount_breakdown='null'::jsonb`)
		code, out := call(tokAdmin, "GET", "/discount-code-report?dateFrom=2026-10-20&dateTo=2026-10-20", nil)
		if code != 200 {
			t.Fatalf("report with jsonb null orders: %d %v", code, out)
		}
		rows, _ := out["data"].([]any)
		if len(rows) != 1 {
			t.Fatalf("rows=%d want only the array order's code", len(rows))
		}
		if m, _ := rows[0].(map[string]any); m["code"] != "BD10" {
			t.Errorf("code=%v want BD10", m["code"])
		}
	})

	sub("7 functions never raise and triggers fill fixture inserts", func(t *testing.T) {
		if got := str(`SELECT business_date_at('00000000-0000-4000-8b00-0000000000ff'::uuid,'2026-10-19T17:30:00Z')::text`); got != "2026-10-20" {
			t.Errorf("unknown outlet must fall back to Asia/Jakarta: %s", got)
		}
		if got := str(`SELECT order_business_date('00000000-0000-4000-8b00-0000000000ff'::uuid,'00000000-0000-4000-8b00-0000000000fe'::uuid,NULL,'2026-10-19T17:30:00Z')::text`); got != "2026-10-20" {
			t.Errorf("unknown outlet and shift: %s", got)
		}
		if got := str(`SELECT count(*)::text FROM orders WHERE business_date IS NULL`); got != "0" {
			t.Errorf("orders with NULL business_date: %s", got)
		}
		if got := str(`SELECT count(*)::text FROM shifts WHERE business_date IS NULL`); got != "0" {
			t.Errorf("shifts with NULL business_date: %s", got)
		}
	})

	// F26: the order read exposes when the tablet recorded the sale beside the server receive
	// time. An offline sale keeps its earlier client time; a row without one reads null.
	sub("8 orders list projects clientCreatedAt and is null for an old row", func(t *testing.T) {
		offline := order("f26-offline", outW, "", 100, "2026-11-09T08:46:00Z", "2026-11-09T01:31:00Z")
		old := order("f26-old", outW, "", 200, "2026-11-09T08:50:00Z", "")
		list := get(tokAdmin, "/orders?dateFrom=2026-11-09&dateTo=2026-11-09&outletId=all")
		got := map[string]map[string]any{}
		for _, r := range list["data"].([]any) {
			m := r.(map[string]any)
			got[m["id"].(string)] = m
		}
		if m := got[offline]; m == nil || m["clientCreatedAt"] != "2026-11-09T01:31:00Z" || m["createdAt"] != "2026-11-09T08:46:00Z" {
			t.Errorf("offline order times: %v", m)
		}
		if m := got[old]; m == nil || m["clientCreatedAt"] != nil || m["createdAt"] != "2026-11-09T08:50:00Z" {
			t.Errorf("old order must read clientCreatedAt null: %v", m)
		}
	})
}
