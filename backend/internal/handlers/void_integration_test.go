package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/ledger"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Void phase 1: the void write path, its audit record, the ledger kind and the ERP hold.
// Opt-in fresh synthetic cluster (port 26482, prefix VD). Later void phases add subtests here.
func TestVoidPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "VD", 26482)
	const (
		outlet  = "00000000-0000-4000-9100-000000000001"
		adminU  = "00000000-0000-4000-9100-000000000011"
		cashier = "00000000-0000-4000-9100-000000000012"
		manager = "00000000-0000-4000-9100-000000000013"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'VD Outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
	      ($1,'vd-admin@example.invalid','x','VD Admin','admin',NULL),
	      ($2,'vd-cashier@example.invalid','x','VD Kasir','cashier',$4),
	      ($3,'vd-manager@example.invalid','x','VD Manager','manager',$4)`, adminU, cashier, manager, outlet)

	t.Run("migration_shape", func(t *testing.T) {
		// Re-run the migration's grant statements against the users seeded above (the migration
		// itself ran on an empty database).
		raw, err := os.ReadFile(filepath.Join("..", "db", "migrations", "0092_order_voids.sql"))
		if err != nil {
			t.Fatal(err)
		}
		_, grants, ok := strings.Cut(string(raw), "-- ── Grants")
		if !ok {
			t.Fatal("grant section missing from 0092")
		}
		exec(grants[strings.Index(grants, "\n")+1:])

		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_permissions WHERE user_id=$1 AND permission='void_own_shift'`, cashier).Scan(&n); err != nil || n != 1 {
			t.Fatalf("cashier void_own_shift rows = %d, %v", n, err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_permissions WHERE user_id IN ($1,$2) AND permission LIKE 'void%'`, manager, adminU).Scan(&n); err != nil || n != 0 {
			t.Fatalf("manager/admin got void grants: %d, %v", n, err)
		}
		var days int
		if err := pool.QueryRow(ctx, `SELECT void_window_days FROM app_settings WHERE id=1`).Scan(&days); err != nil || days != 7 {
			t.Fatalf("void_window_days = %d, %v", days, err)
		}
		// The three kind vocabularies accept 'void' (the ledger and ERP outbox rows, the points ledger).
		exec(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,qty,qty_before,qty_after,ref_type,ref_id,occurred_at)
		      VALUES (gen_random_uuid(),'vd-shape-1','void','outlet',$1,gen_random_uuid(),'100ml',1,0,1,'order',gen_random_uuid(),now())`, outlet)
	})

	t.Run("void_audit_append_only", func(t *testing.T) {
		const orderID = "00000000-0000-4000-9100-0000000000a1"
		const voidID = "00000000-0000-4000-9100-0000000000b1"
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,amount_paid,status)
		      VALUES($1,'VD-A1',gen_random_uuid(),'vd-a1',$2,$3,'VD Kasir',1000,1000,'cash',1000,'completed')`, orderID, outlet, cashier)
		exec(`INSERT INTO order_voids(id,order_id,outlet_id,business_date,after_close,counted_in_close,source,authority,mode,reason_code,
		        original_total,original_payment_method,original_tenders,visit_reversed,erp_document_key)
		      VALUES($1,$2,$3,current_date,false,false,'pos','own_shift','none','salah_barang',1000,'cash','[]'::jsonb,false,'void:x')`, voidID, orderID, outlet)
		exec(`INSERT INTO order_void_items(void_id,movement_key,product_id,variant_size,qty,choice)
		      VALUES($1,'k1',gen_random_uuid(),'100ml',1,'restock')`, voidID)
		for _, q := range []string{
			`UPDATE order_voids SET note='x'`,
			`DELETE FROM order_voids`,
			`DELETE FROM order_void_items`,
			`UPDATE order_void_items SET qty=2`,
		} {
			_, err := pool.Exec(ctx, q)
			if err == nil || !strings.Contains(err.Error(), "void audit rows are append-only") {
				t.Fatalf("%s: err = %v, want the append-only trigger", q, err)
			}
		}
		// A replacement link and the 'lainnya' note rule are enforced by CHECKs.
		const orderB = "00000000-0000-4000-9100-0000000000a2"
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,amount_paid,status)
		      VALUES($1,'VD-A2',gen_random_uuid(),'vd-a2',$2,$3,'VD Kasir',1000,1000,'cash',1000,'completed')`, orderB, outlet, cashier)
		ins := `INSERT INTO order_voids(order_id,outlet_id,business_date,after_close,counted_in_close,source,authority,mode,reason_code,note,
		        original_total,original_payment_method,original_tenders,visit_reversed,erp_document_key)
		      VALUES($1,$2,current_date,false,false,'pos','own_shift',$3,$4,$5,1,'cash','[]'::jsonb,false,'x')`
		for name, c := range map[string]struct{ mode, reason, note, want string }{
			"order_voids_replace_link":   {"replace", "salah_barang", "", "order_voids_replace_link"},
			"order_voids_note_for_other": {"none", "lainnya", "pendek", "order_voids_note_for_other"},
		} {
			_, err := pool.Exec(ctx, ins, orderB, outlet, c.mode, c.reason, c.note)
			var pg *pgconn.PgError
			if !errors.As(err, &pg) || pg.ConstraintName != c.want {
				t.Fatalf("%s: err = %v, want constraint %s", name, err, c.want)
			}
		}
		// The followup table is append-only too, and the other two kinds accept 'void'.
		exec(`INSERT INTO order_void_followups(void_id,kind) VALUES($1,'no_replacement')`, voidID)
		if _, err := pool.Exec(ctx, `UPDATE order_void_followups SET note='x'`); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("followup update err = %v", err)
		}
		exec(`WITH c AS (INSERT INTO customers(name,phone) VALUES('VD C','0800000001') RETURNING id)
		      INSERT INTO point_transactions(customer_id,type,points,balance_after) SELECT id,'void',1,1 FROM c`)
	})

	t.Run("void_erp_held", func(t *testing.T) {
		const (
			prod     = "00000000-0000-4000-9100-0000000000c1"
			plainO   = "00000000-0000-4000-9100-0000000000d1"
			origO    = "00000000-0000-4000-9100-0000000000d2"
			replO    = "00000000-0000-4000-9100-0000000000d3"
			voidDoc  = "void:vd-erp-held"
			variant  = "100ml"
			otherDoc = "sale:vd-erp-plain"
		)
		exec(`INSERT INTO products(id,name) VALUES($1,'VD PRODUCT')`, prod)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,'VDSKU1')`, prod, variant)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,10)`, outlet, prod, variant)
		for i, id := range []string{plainO, origO, replO} {
			repl := any(nil)
			if id == replO {
				repl = origO
			}
			exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,amount_paid,status,replaces_order_id)
			      VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'VD Kasir',1000,1000,'cash',1000,'completed',$6)`,
				id, "VD-ERP-"+string(rune('1'+i)), "vd-erp-"+id, outlet, cashier, repl)
		}
		record := func(key string, kind ledger.Kind, refID string, qty int) {
			t.Helper()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := ledger.RecordDeltas(ctx, tx, ledger.Document{
				Key: key, Kind: kind, LocationType: ledger.LocOutlet, LocationID: outlet,
				RefType: "order", RefID: refID, OccurredAt: time.Now(),
				Lines: []ledger.Line{{ProductID: prod, VariantSize: variant, Qty: qty, DedupeKey: key + ":l1"}},
			}); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		}
		record(voidDoc, ledger.KindVoid, origO, 1)
		record("sale:vd-erp-repl", ledger.KindSale, replO, -1)
		record("refund:vd-erp-repl", ledger.KindRefund, replO, 1)
		record(otherDoc, ledger.KindSale, plainO, -1)

		type row struct {
			status, hold string
			next         time.Time
		}
		get := func(docKey string) row {
			t.Helper()
			var r row
			if err := pool.QueryRow(ctx, `SELECT status, COALESCE(hold_reason,''), next_attempt_at FROM erp_outbox WHERE doc_key=$1`, docKey).Scan(&r.status, &r.hold, &r.next); err != nil {
				t.Fatalf("%s: %v", docKey, err)
			}
			return r
		}
		for _, k := range []string{voidDoc, "sale:vd-erp-repl", "refund:vd-erp-repl"} {
			r := get(k)
			if r.status != "held" || r.hold != ledger.VoidERPHoldReason || r.next.After(time.Now().Add(time.Minute)) {
				t.Fatalf("%s outbox = %+v, want held/%s with a finite next_attempt_at", k, r, ledger.VoidERPHoldReason)
			}
		}
		if r := get(otherDoc); r.status != "pending" || r.hold != "" {
			t.Fatalf("plain sale outbox = %+v, want pending", r)
		}

		// The relay claims the plain sale only: the held rows stay put.
		exec(`UPDATE erp_outbox SET next_attempt_at = now() - interval '1 hour' WHERE status IN ('held','pending')`)
		p := &obrPoster{reply: obrAnswer(500, `{}`)}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		for _, k := range []string{voidDoc, "sale:vd-erp-repl", "refund:vd-erp-repl"} {
			r := get(k)
			if r.status != "held" || r.hold != ledger.VoidERPHoldReason {
				t.Fatalf("%s after a relay run = %+v, want untouched held/%s", k, r, ledger.VoidERPHoldReason)
			}
			var attempts int
			var docID string
			if err := pool.QueryRow(ctx, `SELECT attempts, document_id::text FROM erp_outbox WHERE doc_key=$1`, k).Scan(&attempts, &docID); err != nil || attempts != 0 {
				t.Fatalf("%s attempts = %d, %v; a held void row must never be claimed", k, attempts, err)
			}
			if n := len(p.callsFor(docID)); n != 0 {
				t.Fatalf("%s was posted to the ERP %d times", k, n)
			}
		}
		if rep.Claimed != 1 {
			t.Fatalf("relay claimed %d rows, want only the plain sale", rep.Claimed)
		}
		// The admin list scans held rows (a finite next_attempt_at; 'infinity' would break pgx).
		items, total, err := erp.List(ctx, pool, "held", "", 50, 0)
		if err != nil || total < 3 || len(items) < 3 {
			t.Fatalf("erp.List held = %d items, total %d, err %v", len(items), total, err)
		}
		if _, _, err := erp.List(ctx, pool, "", "void", 50, 0); err != nil {
			t.Fatalf("erp.List kind=void: %v", err)
		}
	})

	t.Run("erp_retry_refuses_void_hold", func(t *testing.T) {
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM erp_outbox WHERE doc_key='void:vd-erp-held'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := erp.Retry(ctx, pool, id); !errors.Is(err, erp.ErrNotRetryable) {
			t.Fatalf("Retry on a void-held row = %v, want ErrNotRetryable", err)
		}
		var status, hold string
		if err := pool.QueryRow(ctx, `SELECT status, COALESCE(hold_reason,'') FROM erp_outbox WHERE id=$1`, id).Scan(&status, &hold); err != nil || status != "held" || hold != ledger.VoidERPHoldReason {
			t.Fatalf("row after Retry = %s/%s, %v", status, hold, err)
		}
	})

	// ── Task 1.4: the void write path ────────────────────────────────────────────────────────
	svc := service.NewOrderService(pool)
	var seq atomic.Int64
	newID := func(group string) string { return fmt.Sprintf("00000000-0000-4000-9100-%s%011d", group, seq.Add(1)) }
	one := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, q)
		}
		return n
	}
	str := func(q string, args ...any) string {
		t.Helper()
		var v string
		if err := pool.QueryRow(ctx, q, args...).Scan(&v); err != nil {
			t.Fatalf("%v: %s", err, q)
		}
		return v
	}
	const size = "std"
	product := func(stock int) string {
		pid := newID("1")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, "VD "+pid[len(pid)-4:])
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,$3)`, pid, size, "VD"+pid[len(pid)-8:])
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, outlet, pid, size, stock)
		return pid
	}
	stockOf := func(pid string) int {
		return one(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outlet, pid, size)
	}
	openShift := func() string {
		exec(`UPDATE shifts SET status='closed', closed_at=now() WHERE outlet_id=$1 AND status='open'`, outlet)
		id := newID("3")
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) VALUES($1,$2,$3,'VD Kasir','open',now() - interval '1 hour')`, id, outlet, cashier)
		return id
	}
	giveaway := product(50)
	exec(`INSERT INTO outlet_giveaways(outlet_id,product_id,variant_size) VALUES($1,$2,$3)`, outlet, giveaway, size)
	type saleOpts struct {
		shift, cust, code string
		earned, redeemed  int
	}
	sale := func(o saleOpts, pids ...string) string {
		t.Helper()
		var items []service.OrderItem
		total := 0.0
		for _, pid := range pids {
			items = append(items, service.OrderItem{ProductID: pid, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000})
			total += 100000
		}
		id, dup, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: "vd-sale-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
			CashierID: cashier, CashierName: "VD Kasir", CustomerID: o.cust, Items: items,
			PaymentMethod: "cash", AmountPaid: total, ShiftID: o.shift,
		})
		if err != nil || dup {
			t.Fatalf("sale: dup=%v err=%v", dup, err)
		}
		if o.earned > 0 || o.redeemed > 0 {
			exec(`UPDATE orders SET points_earned=$2, points_redeemed=$3 WHERE id=$1`, id, o.earned, o.redeemed)
		}
		if o.code != "" {
			exec(`UPDATE orders SET discount_code=$2, applied_discount_codes=jsonb_build_array($2::text) WHERE id=$1`, id, o.code)
		}
		return id
	}
	customer := func(points int) string {
		id := newID("2")
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'VD Cust',$2,$3)`, id, "+6285"+id[len(id)-9:], points)
		return id
	}
	voidIn := func(orderID, shift string) service.VoidInput {
		return service.VoidInput{
			OutletID: outlet, OrderID: orderID, Reason: service.VoidReasonWrongPayment, Mode: service.VoidModeNone,
			Source: service.VoidSourcePOS, UserID: cashier, UserName: "VD Kasir", DeviceID: "vd-dev", ClientVoidUUID: newID("4"),
			CallerShiftID: shift, CanVoidOwnShift: true,
		}
	}
	status := func(orderID string) string { return str(`SELECT status FROM orders WHERE id=$1`, orderID) }
	pointsOf := func(cust string) int { return one(`SELECT points FROM customers WHERE id=$1`, cust) }
	closeShift := func(shift string) {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.CloseShiftTx(ctx, tx, outlet, shift, 0, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("void_none_restores_everything", func(t *testing.T) {
		shift := openShift()
		p1, p2 := product(10), product(10)
		cust := customer(500)
		exec(`INSERT INTO discount_codes(code,type,value,usage_count) VALUES('HEMAT','fixed',1000,1)`)
		spentBefore := one(`SELECT total_spent::int FROM customers WHERE id=$1`, cust)
		visitsBefore := one(`SELECT visit_count FROM customers WHERE id=$1`, cust)
		g0, s1, s2 := stockOf(giveaway), stockOf(p1), stockOf(p2)
		id := sale(saleOpts{shift: shift, cust: cust, code: "HEMAT", earned: 100, redeemed: 50}, p1, p2)
		exec(`UPDATE customers SET points=550 WHERE id=$1`, cust) // 500 - 50 redeemed + 100 earned
		if stockOf(p1) != s1-1 || stockOf(giveaway) != g0-1 {
			t.Fatalf("fixture: the sale did not move stock (p1 %d giveaway %d)", stockOf(p1), stockOf(giveaway))
		}
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if status(id) != "cancelled" || res.Authority != service.VoidOwnShift || res.Replayed {
			t.Fatalf("status %s result %+v", status(id), res)
		}
		if str(`SELECT void_id::text FROM orders WHERE id=$1`, id) != res.VoidID {
			t.Fatal("orders.void_id does not point at the audit row")
		}
		if stockOf(p1) != s1 || stockOf(p2) != s2 || stockOf(giveaway) != g0 {
			t.Fatalf("stock p1 %d/%d p2 %d/%d giveaway %d/%d: not back to pre-sale", stockOf(p1), s1, stockOf(p2), s2, stockOf(giveaway), g0)
		}
		if got := pointsOf(cust); got != 500 {
			t.Fatalf("points = %d, want 500", got)
		}
		if n := one(`SELECT count(*) FROM point_transactions WHERE order_id=$1 AND type='void'`, id); n != 2 {
			t.Fatalf("void point rows = %d, want 2", n)
		}
		if one(`SELECT total_spent::int FROM customers WHERE id=$1`, cust) != spentBefore || one(`SELECT visit_count FROM customers WHERE id=$1`, cust) != visitsBefore {
			t.Fatal("customer spend or visit was not reversed")
		}
		if one(`SELECT usage_count FROM discount_codes WHERE code='HEMAT'`) != 0 {
			t.Fatal("HEMAT usage not released")
		}
		if str(`SELECT erp_document_key FROM order_voids WHERE id=$1`, res.VoidID) != "void:"+res.VoidID {
			t.Fatal("erp_document_key")
		}
		if n := one(`SELECT count(*) FROM order_void_items WHERE void_id=$1 AND choice='restock'`, res.VoidID); n != 3 {
			t.Fatalf("restock audit rows = %d, want 3", n)
		}
		if n := one(`SELECT count(*) FROM order_refunds WHERE order_id=$1`, id); n != 0 {
			t.Fatalf("a void wrote %d order_refunds rows", n)
		}
		if n := one(`SELECT count(*) FROM erp_outbox WHERE doc_key=$1 AND status='held'`, "void:"+res.VoidID); n != 1 {
			t.Fatalf("held void outbox rows = %d, want 1", n)
		}
		closeShift(shift) // the closed shift no longer counts the sale
		if one(`SELECT total_orders FROM shifts WHERE id=$1`, shift) != 0 || one(`SELECT total_sales::int FROM shifts WHERE id=$1`, shift) != 0 || one(`SELECT cash_sales::int FROM shifts WHERE id=$1`, shift) != 0 {
			t.Fatal("closed shift still counts the voided sale")
		}
	})

	t.Run("void_points_spent_floor", func(t *testing.T) {
		// Restore first: balance 30 + 20 redeemed = 50 available, earned 100 -> claw 50, forgive 50.
		shift := openShift()
		cust := customer(0)
		id := sale(saleOpts{shift: shift, cust: cust, earned: 100, redeemed: 20}, product(5))
		exec(`UPDATE customers SET points=30 WHERE id=$1`, cust)
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if one(`SELECT points_clawed FROM order_voids WHERE id=$1`, res.VoidID) != 50 || one(`SELECT points_forgiven FROM order_voids WHERE id=$1`, res.VoidID) != 50 ||
			one(`SELECT points_restored FROM order_voids WHERE id=$1`, res.VoidID) != 20 {
			t.Fatal("audit points clawed/forgiven/restored")
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0 (floored)", got)
		}
	})

	t.Run("void_points_exact_reversal", func(t *testing.T) {
		// The customer had 500, the sale redeemed 50 and earned 100 (balance 550), then spent 460
		// elsewhere (balance 90). Had the sale never happened they would hold 500 - 460 = 40.
		shift := openShift()
		cust := customer(500)
		id := sale(saleOpts{shift: shift, cust: cust, earned: 100, redeemed: 50}, product(5))
		exec(`UPDATE customers SET points=90 WHERE id=$1`, cust)
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if got := pointsOf(cust); got != 40 {
			t.Fatalf("balance = %d, want 40 (as if the sale never happened)", got)
		}
		if one(`SELECT points_clawed FROM order_voids WHERE id=$1`, res.VoidID) != 100 || one(`SELECT points_forgiven FROM order_voids WHERE id=$1`, res.VoidID) != 0 {
			t.Fatal("expected the whole earned amount clawed and nothing forgiven")
		}
		// Ledger: the restore row comes first (balance 140), then the claw row (balance 40).
		var restoreBal, clawBal int
		if err := pool.QueryRow(ctx, `SELECT
		    (SELECT balance_after FROM point_transactions WHERE order_id=$1 AND type='void' AND points > 0),
		    (SELECT balance_after FROM point_transactions WHERE order_id=$1 AND type='void' AND points < 0)`, id).Scan(&restoreBal, &clawBal); err != nil || restoreBal != 140 || clawBal != 40 {
			t.Fatalf("ledger balances restore=%d claw=%d, %v; want 140 then 40", restoreBal, clawBal, err)
		}
	})

	t.Run("void_last_visit_moves_back", func(t *testing.T) {
		shift := openShift()
		cust := customer(0)
		lastVisit := func() string { return str(`SELECT COALESCE(last_visit::text,'null') FROM customers WHERE id=$1`, cust) }
		createdAt := func(id string) string { return str(`SELECT created_at::text FROM orders WHERE id=$1`, id) }
		first := sale(saleOpts{shift: shift, cust: cust}, product(5))
		second := sale(saleOpts{shift: shift, cust: cust}, product(5))
		if lastVisit() != createdAt(second) || createdAt(first) == createdAt(second) {
			t.Fatal("fixture: last_visit should be the latest sale's time, distinct from the first")
		}
		// Voiding the latest sale moves last_visit back to the latest remaining order.
		if _, err := svc.VoidOrder(ctx, voidIn(second, shift)); err != nil {
			t.Fatal(err)
		}
		if got := lastVisit(); got != createdAt(first) {
			t.Fatalf("last_visit = %s, want the remaining order's time %s", got, createdAt(first))
		}
		// A stored last_visit later than the voided sale is never touched.
		third := sale(saleOpts{shift: shift, cust: cust}, product(5))
		exec(`UPDATE customers SET last_visit = now() + interval '1 day' WHERE id=$1`, cust)
		later := lastVisit()
		if _, err := svc.VoidOrder(ctx, voidIn(third, shift)); err != nil {
			t.Fatal(err)
		}
		if got := lastVisit(); got != later {
			t.Fatalf("a later last_visit changed from %s to %s", later, got)
		}
		// The customer's only live order voided: nothing remains, so last_visit clears.
		if _, err := svc.VoidOrder(ctx, voidIn(first, shift)); err != nil {
			t.Fatal(err)
		}
		if got := lastVisit(); got != later {
			t.Fatalf("voiding an older sale must not change a later last_visit (got %s)", got)
		}
		solo := customer(0)
		soloOrder := sale(saleOpts{shift: shift, cust: solo}, product(5))
		if str(`SELECT COALESCE(last_visit::text,'null') FROM customers WHERE id=$1`, solo) != createdAt(soloOrder) {
			t.Fatal("fixture: solo last_visit")
		}
		if _, err := svc.VoidOrder(ctx, voidIn(soloOrder, shift)); err != nil {
			t.Fatal(err)
		}
		if got := str(`SELECT COALESCE(last_visit::text,'null') FROM customers WHERE id=$1`, solo); got != "null" {
			t.Fatalf("a customer whose only order was voided has last_visit %s, want null", got)
		}
	})

	t.Run("void_points_balance_zero_no_redeem", func(t *testing.T) {
		shift := openShift()
		cust := customer(0)
		id := sale(saleOpts{shift: shift, cust: cust, earned: 100}, product(5))
		exec(`UPDATE customers SET points=0 WHERE id=$1`, cust)
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if one(`SELECT points_clawed FROM order_voids WHERE id=$1`, res.VoidID) != 0 || one(`SELECT points_forgiven FROM order_voids WHERE id=$1`, res.VoidID) != 100 {
			t.Fatal("expected clawed 0 forgiven 100")
		}
		if n := one(`SELECT count(*) FROM point_transactions WHERE order_id=$1 AND type='void'`, id); n != 0 {
			t.Fatalf("void point rows = %d, want none (CHECK points <> 0)", n)
		}
	})

	countFor := func(pid string) string {
		cid := newID("5")
		exec(`INSERT INTO stock_counts(id,name,status,outlet_id,completed_at) VALUES($1,'VD count','completed',$2,now() + interval '1 minute')`, cid, outlet)
		exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size,frozen_qty,actual_qty,difference) VALUES($1,$2,'VD',$3,5,5,0)`, cid, pid, size)
		return cid
	}
	countedSale := func(shift string) (string, string, string, string) {
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		cid := countFor(p)
		return id, p, cid, "sale:" + str(`SELECT id::text FROM order_items WHERE order_id=$1`, id)
	}

	t.Run("void_counted_after_skip", func(t *testing.T) {
		shift := openShift()
		id, p, cid, key := countedSale(shift)
		before := stockOf(p)
		in := voidIn(id, shift)
		in.StockChoices = map[string]service.VoidStockChoice{key: service.VoidStockSkipCounted}
		res, err := svc.VoidOrder(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		if stockOf(p) != before {
			t.Fatalf("a skipped counted line was restocked: %d -> %d", before, stockOf(p))
		}
		var choice, counted string
		if err := pool.QueryRow(ctx, `SELECT choice, counted_stock_count_id::text FROM order_void_items WHERE void_id=$1 AND movement_key=$2`, res.VoidID, key).Scan(&choice, &counted); err != nil || choice != "skip_counted" || counted != cid {
			t.Fatalf("audit row = %s %s %v", choice, counted, err)
		}
	})

	t.Run("void_counted_after_restock_chosen", func(t *testing.T) {
		shift := openShift()
		id, p, cid, key := countedSale(shift)
		before := stockOf(p)
		in := voidIn(id, shift)
		in.StockChoices = map[string]service.VoidStockChoice{key: service.VoidStockRestock}
		res, err := svc.VoidOrder(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		if stockOf(p) != before+1 {
			t.Fatalf("stock %d -> %d, want +1", before, stockOf(p))
		}
		var choice, counted string
		if err := pool.QueryRow(ctx, `SELECT choice, counted_stock_count_id::text FROM order_void_items WHERE void_id=$1 AND movement_key=$2`, res.VoidID, key).Scan(&choice, &counted); err != nil || choice != "restock" || counted != cid {
			t.Fatalf("audit row = %s %s %v", choice, counted, err)
		}
	})

	t.Run("void_counted_after_choice_missing_refused", func(t *testing.T) {
		shift := openShift()
		id, p, _, _ := countedSale(shift)
		before := stockOf(p)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); !errors.Is(err, service.ErrVoidCountNeedsChoice) {
			t.Fatalf("err = %v, want ErrVoidCountNeedsChoice", err)
		}
		if status(id) != "completed" || stockOf(p) != before || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 0 {
			t.Fatal("a refused void changed something")
		}
	})

	t.Run("void_count_before_sale_plain_restock", func(t *testing.T) {
		// A stock count completed BEFORE the sale did not cover its decrement: no choice is needed,
		// so an offline void (no stock choices) restocks.
		shift := openShift()
		p := product(5)
		cid := newID("5")
		exec(`INSERT INTO stock_counts(id,name,status,outlet_id,completed_at) VALUES($1,'VD old count','completed',$2,now() - interval '1 hour')`, cid, outlet)
		exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size,frozen_qty,actual_qty,difference) VALUES($1,$2,'VD',$3,5,5,0)`, cid, p, size)
		id := sale(saleOpts{shift: shift}, p)
		before := stockOf(p)
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if stockOf(p) != before+1 {
			t.Fatalf("stock %d -> %d, want +1", before, stockOf(p))
		}
		if one(`SELECT count(*) FROM order_void_items WHERE void_id=$1 AND counted_stock_count_id IS NOT NULL`, res.VoidID) != 0 {
			t.Fatal("an earlier count was recorded as covering the sale")
		}
	})

	t.Run("void_open_count_needs_choice", func(t *testing.T) {
		// A count still awaiting approval applies actual minus the baseline taken at counting time:
		// restocking blindly would be corrected a second time when it is approved.
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		cid := newID("5")
		exec(`INSERT INTO stock_counts(id,name,status,outlet_id) VALUES($1,'VD open count','pending_approval',$2)`, cid, outlet)
		exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size,frozen_qty,actual_qty,difference,counted_at) VALUES($1,$2,'VD',$3,5,5,0,now() + interval '1 minute')`, cid, p, size)
		before := stockOf(p)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); !errors.Is(err, service.ErrVoidCountNeedsChoice) {
			t.Fatalf("err = %v, want ErrVoidCountNeedsChoice", err)
		}
		if status(id) != "completed" || stockOf(p) != before {
			t.Fatal("a refused void changed something")
		}
	})

	t.Run("void_gone_variant_recorded", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		exec(`DELETE FROM outlet_variant_stock WHERE product_id=$1`, p)
		exec(`DELETE FROM product_variants WHERE product_id=$1`, p)
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		if one(`SELECT count(*) FROM order_void_items WHERE void_id=$1 AND choice='gone'`, res.VoidID) != 1 {
			t.Fatal("a line whose variant and stock row are gone must be recorded as gone, not restocked")
		}
		if one(`SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1`, p) != 0 {
			t.Fatal("a gone line created a stock row")
		}
	})

	t.Run("void_refunded_refused", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		if err := svc.Refund(ctx, service.RefundInput{OutletID: outlet, OrderID: id, Reason: "vd refund", ShiftID: shift, UserID: cashier, UserName: "VD Kasir"}); err != nil {
			t.Fatal(err)
		}
		before := stockOf(p)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); !errors.Is(err, service.ErrVoidRefunded) {
			t.Fatalf("err = %v, want ErrVoidRefunded", err)
		}
		if stockOf(p) != before || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 0 {
			t.Fatal("a refused void changed something")
		}
	})

	t.Run("void_twice_conflict", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); err != nil {
			t.Fatal(err)
		}
		after := stockOf(p)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); !errors.Is(err, service.ErrVoidAlreadyVoided) {
			t.Fatalf("err = %v, want ErrVoidAlreadyVoided", err)
		}
		if stockOf(p) != after {
			t.Fatal("second void moved stock")
		}
	})

	t.Run("void_replay_same_key_ok", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := voidIn(id, shift)
		first, err := svc.VoidOrder(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		after := stockOf(p)
		again, err := svc.VoidOrder(ctx, in)
		if err != nil || !again.Replayed || again.VoidID != first.VoidID {
			t.Fatalf("replay = %+v, %v", again, err)
		}
		if stockOf(p) != after || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 1 {
			t.Fatal("replay applied again")
		}
	})

	t.Run("void_races_refund", func(t *testing.T) {
		shift := openShift()
		p := product(100)
		for round := 0; round < 20; round++ {
			id := sale(saleOpts{shift: shift}, p)
			var wg sync.WaitGroup
			var voidErr, refundErr error
			wg.Add(2)
			go func() {
				defer wg.Done()
				_, voidErr = svc.VoidOrder(ctx, voidIn(id, shift))
			}()
			go func() {
				defer wg.Done()
				refundErr = svc.Refund(ctx, service.RefundInput{OutletID: outlet, OrderID: id, Reason: "vd race", ShiftID: shift, UserID: cashier, UserName: "VD Kasir"})
			}()
			wg.Wait()
			voids := one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id)
			refunds := one(`SELECT count(*) FROM order_refunds WHERE order_id=$1`, id)
			if voids+refunds != 1 {
				t.Fatalf("round %d: %d voids + %d refunds, want exactly one", round, voids, refunds)
			}
			// The loser must lose cleanly (not by a deadlock or other abort).
			if voids == 1 && !errors.Is(refundErr, service.ErrOrderNotRefundable) {
				t.Fatalf("round %d: void won, refund err = %v, want ErrOrderNotRefundable (void err %v)", round, refundErr, voidErr)
			}
			if refunds == 1 && !errors.Is(voidErr, service.ErrVoidRefunded) {
				t.Fatalf("round %d: refund won, void err = %v, want ErrVoidRefunded (refund err %v)", round, voidErr, refundErr)
			}
		}
	})

	t.Run("void_after_close_refused_phase1", func(t *testing.T) {
		shift := openShift()
		id := sale(saleOpts{shift: shift}, product(5))
		closeShift(shift)
		in := voidIn(id, "")
		in.Source, in.CanVoidOwnShift, in.CanVoidAny = service.VoidSourceBackoffice, false, true
		if _, err := svc.VoidOrder(ctx, in); !errors.Is(err, service.ErrVoidAfterCloseNotYet) {
			t.Fatalf("err = %v, want ErrVoidAfterCloseNotYet", err)
		}
		if status(id) != "completed" {
			t.Fatal("refused void changed the order")
		}
	})

	t.Run("bundle_sale_void_whole", func(t *testing.T) {
		shift := openShift()
		pids := []string{product(5), product(5), product(5)}
		before := []int{stockOf(pids[0]), stockOf(pids[1]), stockOf(pids[2])}
		id := sale(saleOpts{shift: shift}, pids...)
		exec(`UPDATE order_items oi SET bundle_group=1, bundle_role=(ARRAY['large','atomizer','vial'])[r.n]
		      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM order_items WHERE order_id=$1) r WHERE oi.id=r.id`, id)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); err != nil {
			t.Fatal(err)
		}
		for i, p := range pids {
			if stockOf(p) != before[i] {
				t.Fatalf("bundle piece %d not restocked", i)
			}
		}
	})

	t.Run("legacy_cancelled_not_voidable", func(t *testing.T) {
		id := newID("a")
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,amount_paid,status)
		      VALUES($1,$2,gen_random_uuid(),$3,$4,$5,'VD Kasir',1000,1000,'cash',1000,'cancelled')`, id, "VD-LEG-"+id[len(id)-4:], "vd-leg-"+id, outlet, cashier)
		if _, err := svc.VoidOrder(ctx, voidIn(id, "")); !errors.Is(err, service.ErrVoidAlreadyVoided) {
			t.Fatalf("err = %v, want ErrVoidAlreadyVoided", err)
		}
	})

	t.Run("void_no_movements_refused", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		exec(`DELETE FROM stock_movements WHERE ref_type='order' AND ref_id=$1 AND kind='sale'`, id)
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); !errors.Is(err, service.ErrVoidNoMovements) {
			t.Fatalf("err = %v, want ErrVoidNoMovements", err)
		}
		if status(id) != "completed" {
			t.Fatal("refused void changed the order")
		}
	})

	// ── Task 1.5: the sync item, the direct endpoint, the preview, the order read, the setting ──
	rd, wr := read.New(pool), write.New(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	key := []byte("VD-SYNTHETIC-TEST-KEY")
	tok := func(user, role string, perms []string) string {
		t.Helper()
		v, err := auth.IssueAccess(key, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: key}))
	router.Post("/sync/batch", h.SyncBatch)
	router.Get("/orders/{id}", h.Order)
	router.With(mw.RequirePermission("void_any")).Post("/orders/{id}/void", h.VoidOrder)
	router.Get("/orders/{id}/void-preview", h.VoidPreview)
	do := func(token, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&buf).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	const syncDevice = "vd-sync-dev"
	sendItem := func(token string, item map[string]any) map[string]any {
		t.Helper()
		code, body := do(token, http.MethodPost, "/sync/batch", map[string]any{"items": []any{item}})
		if code != http.StatusOK {
			t.Fatalf("sync batch = %d %v", code, body)
		}
		return body["data"].(map[string]any)["results"].([]any)[0].(map[string]any)
	}
	voidItem := func(shift, orderID string, extra map[string]any) map[string]any {
		t.Helper()
		uid := newID("4")
		payload := map[string]any{
			"orderId": orderID, "reasonCode": "salah_barang", "mode": "none", "orderNumber": "VD-1", "total": 100000,
			"deviceId": syncDevice, "orderUuid": uid,
		}
		for k, v := range extra {
			payload[k] = v
		}
		return map[string]any{
			"type": "void", "idempotencyKey": syncDevice + ":" + uid, "payload": payload,
			"envelope": map[string]any{"v": 1, "outletId": outlet, "userId": cashier, "deviceId": syncDevice, "capturedAt": time.Now().UTC().Format(time.RFC3339), "shiftId": shift},
		}
	}
	cashierTok := tok(cashier, "cashier", []string{"void_own_shift"})

	t.Run("sync_void_item_ok", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		before := stockOf(p)
		res := sendItem(cashierTok, voidItem(shift, id, nil))
		if res["status"] != "ok" || res["orderId"] != id {
			t.Fatalf("result = %v", res)
		}
		if status(id) != "cancelled" || stockOf(p) != before+1 {
			t.Fatalf("status %s stock %d -> %d", status(id), before, stockOf(p))
		}
		if str(`SELECT source||'/'||authority FROM order_voids WHERE order_id=$1`, id) != "pos/own_shift" {
			t.Fatal("audit source/authority")
		}
	})

	t.Run("void_permission_revoked", func(t *testing.T) {
		shift := openShift()
		first, second := sale(saleOpts{shift: shift}, product(5)), sale(saleOpts{shift: shift}, product(5))
		noPerms := tok(cashier, "cashier", nil)
		// Not committed: forbidden, non-retryable, nothing applied.
		res := sendItem(noPerms, voidItem(shift, first, nil))
		if res["status"] != "error" || res["code"] != "forbidden" || res["retryable"] != false {
			t.Fatalf("result = %v, want a non-retryable forbidden", res)
		}
		if status(first) != "completed" {
			t.Fatal("a refused void changed the order")
		}
		// Committed with the permission, then replayed after it was revoked: ok (M3 rule).
		item := voidItem(shift, second, nil)
		if okRes := sendItem(cashierTok, item); okRes["status"] != "ok" {
			t.Fatalf("result = %v", okRes)
		}
		stockAfter := one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, second)
		replay := sendItem(noPerms, item) // same key and payload, permission now gone
		if replay["status"] != "ok" || replay["orderId"] != second {
			t.Fatalf("replay = %v, want ok with the stored order id (M3 rule)", replay)
		}
		if one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, second) != stockAfter {
			t.Fatal("the replay applied again")
		}
	})

	t.Run("void_preview_lists_counted_lines", func(t *testing.T) {
		shift := openShift()
		id, _, _, key := countedSale(shift)
		code, body := do(cashierTok, http.MethodGet, "/orders/"+id+"/void-preview", nil)
		if code != http.StatusOK {
			t.Fatalf("preview = %d %v", code, body)
		}
		data := body["data"].(map[string]any)
		if data["eligible"] != true || data["authority"] != "own_shift" || data["amountsLocked"] != false {
			t.Fatalf("preview = %v", data)
		}
		var found bool
		for _, l := range data["lines"].([]any) {
			line := l.(map[string]any)
			if line["key"] == key {
				found = true
				if line["countedAfter"] != true || line["stockCountName"] != "VD count" {
					t.Fatalf("line = %v", line)
				}
			}
		}
		if !found {
			t.Fatalf("counted line %s missing from %v", key, data["lines"])
		}
		// Without either void permission the preview is forbidden.
		if code, _ := do(tok(cashier, "cashier", nil), http.MethodGet, "/orders/"+id+"/void-preview", nil); code != http.StatusForbidden {
			t.Fatalf("preview without permission = %d, want 403", code)
		}
	})

	t.Run("order_read_has_void", func(t *testing.T) {
		shift := openShift()
		id := sale(saleOpts{shift: shift}, product(5))
		if _, err := svc.VoidOrder(ctx, voidIn(id, shift)); err != nil {
			t.Fatal(err)
		}
		code, body := do(tok(adminU, "admin", nil), http.MethodGet, "/orders/"+id, nil)
		if code != http.StatusOK {
			t.Fatalf("GET order = %d %v", code, body)
		}
		data := body["data"].(map[string]any)
		v, ok := data["void"].(map[string]any)
		if data["status"] != "cancelled" || !ok || v["reasonCode"] != "salah_metode_pembayaran" || v["mode"] != "none" || v["source"] != "pos" {
			t.Fatalf("order = %v", data)
		}
	})

	t.Run("direct_void_backoffice", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		before := stockOf(p)
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		body := map[string]any{"reasonCode": "transaksi_tes", "mode": "none", "clientVoidUuid": newID("4")}
		if code, _ := do(cashierTok, http.MethodPost, "/orders/"+id+"/void", body); code != http.StatusForbidden {
			t.Fatalf("void_own_shift alone on the Backoffice route = %d, want 403", code)
		}
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{"reasonCode": "transaksi_tes", "mode": "none"}); code != http.StatusBadRequest {
			t.Fatalf("missing clientVoidUuid = %d, want 400", code)
		}
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{"reasonCode": "transaksi_tes", "mode": "replace", "clientVoidUuid": newID("4")}); code != http.StatusBadRequest {
			t.Fatalf("replace mode in phase 1 = %d, want 400", code)
		}
		code, out := do(anyTok, http.MethodPost, "/orders/"+id+"/void", body)
		if code != http.StatusOK || out["data"].(map[string]any)["status"] != "cancelled" {
			t.Fatalf("void = %d %v", code, out)
		}
		if stockOf(p) != before+1 {
			t.Fatalf("stock %d -> %d", before, stockOf(p))
		}
		// A retry with the same client uuid replays; a different uuid conflicts.
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", body); code != http.StatusOK {
			t.Fatalf("replay = %d, want 200", code)
		}
		if stockOf(p) != before+1 || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 1 {
			t.Fatal("replay applied again")
		}
		body["clientVoidUuid"] = newID("4")
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", body); code != http.StatusConflict {
			t.Fatalf("second void = %d, want 409", code)
		}
		if str(`SELECT source||'/'||authority||'/'||device_id FROM order_voids WHERE order_id=$1`, id) != "backoffice/any/backoffice:"+adminU {
			t.Fatal("audit source/authority/device")
		}
	})

	t.Run("void_window_setting_enforced", func(t *testing.T) {
		raw := func(extra string) json.RawMessage {
			return json.RawMessage(`{"taxEnabled":false,"taxRate":0,"roundingEnabled":false,"roundingType":"none","autoOpenShift":false,"allowNegativeStock":false,"paymentMethods":[],"receipt":{}` + extra + `}`)
		}
		if err := wr.UpdateAppSettingsBy(ctx, adminU, raw(`,"voidWindowDays":14`)); err != nil {
			t.Fatal(err)
		}
		if one(`SELECT void_window_days FROM app_settings WHERE id=1`) != 14 {
			t.Fatal("voidWindowDays not stored")
		}
		if err := wr.UpdateAppSettingsBy(ctx, adminU, raw("")); err != nil || one(`SELECT void_window_days FROM app_settings WHERE id=1`) != 14 {
			t.Fatalf("an update that omits voidWindowDays must leave it untouched (err %v)", err)
		}
		if err := wr.UpdateAppSettingsBy(ctx, adminU, raw(`,"voidWindowDays":31`)); err == nil {
			t.Fatal("31 days accepted")
		}
		s, err := rd.AppSettings(ctx)
		if err != nil || s.VoidWindowDays == nil || *s.VoidWindowDays != 14 {
			t.Fatalf("read = %+v, %v", s.VoidWindowDays, err)
		}
		// The window is enforced from the stored value: a sale 3 days old is outside a 1-day window.
		if err := wr.UpdateAppSettingsBy(ctx, adminU, raw(`,"voidWindowDays":1`)); err != nil {
			t.Fatal(err)
		}
		shift := openShift()
		id := sale(saleOpts{shift: shift}, product(5))
		exec(`UPDATE orders SET business_date = business_date - 3 WHERE id=$1`, id)
		in := voidIn(id, "")
		in.Source, in.CanVoidOwnShift, in.CanVoidAny = service.VoidSourceBackoffice, false, true
		if _, err := svc.VoidOrder(ctx, in); err == nil || !strings.Contains(err.Error(), "1 hari") {
			t.Fatalf("err = %v, want the window refusal naming 1 hari", err)
		}
		if err := wr.UpdateAppSettingsBy(ctx, adminU, raw(`,"voidWindowDays":7`)); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatalf("within a 7-day window: %v", err)
		}
	})

	// ── Task 1.6: reports and the movement summary ───────────────────────────────────────────
	t.Run("void_report_exclusion", func(t *testing.T) {
		shift := openShift()
		keep := sale(saleOpts{shift: shift}, product(5))
		gone := sale(saleOpts{shift: shift}, product(5), product(5))
		day := str(`SELECT business_date::text FROM orders WHERE id=$1`, gone)
		dash := func() float64 {
			t.Helper()
			d, err := rd.DashboardAggregate(ctx, read.DashboardFilter{Scope: read.Scope{OutletID: outlet}, From: day, To: day, Trend: read.DashboardTrendDay})
			if err != nil {
				t.Fatal(err)
			}
			return d.Current.Gross
		}
		sum := func() (float64, int) {
			t.Helper()
			sm, err := rd.ReportSummary(ctx, read.OrderFilter{Scope: read.Scope{OutletID: outlet}, ShiftID: shift})
			if err != nil {
				t.Fatal(err)
			}
			return sm.TotalSales, sm.TotalOrders
		}
		if sales, orders := sum(); sales != 300000 || orders != 2 {
			t.Fatalf("fixture: totalSales %v totalOrders %d, want 300000 and 2", sales, orders)
		}
		grossBefore := dash()
		if _, err := svc.VoidOrder(ctx, voidIn(gone, shift)); err != nil {
			t.Fatal(err)
		}
		if sales, orders := sum(); sales != 100000 || orders != 1 {
			t.Fatalf("after the void: totalSales %v totalOrders %d, want 100000 and 1", sales, orders)
		}
		if got := dash(); grossBefore-got != 200000 {
			t.Fatalf("dashboard gross fell by %v, want the voided 200000", grossBefore-got)
		}
		_ = keep
	})

	t.Run("movement_summary_void", func(t *testing.T) {
		shift := openShift()
		x := product(10)
		other := product(10)
		counted := product(10)
		id := sale(saleOpts{shift: shift}, x, x) // two lines of x: 2 units sold
		cid, cp, ccid, ckey := countedSale(shift)
		_, _ = cp, ccid
		_ = counted
		day := str(`SELECT business_date::text FROM orders WHERE id=$1`, id)
		from := str(`SELECT ($1::date - 1)::text`, day)
		to := str(`SELECT ($1::date + 2)::text`, day)
		in := voidIn(id, shift)
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		skip := voidIn(cid, shift)
		skip.StockChoices = map[string]service.VoidStockChoice{ckey: service.VoidStockSkipCounted}
		if _, err := svc.VoidOrder(ctx, skip); err != nil {
			t.Fatal(err)
		}
		// A voided order at another outlet must not leak into this outlet's summary.
		out2 := newID("b")
		exec(`INSERT INTO outlets(id,name) VALUES($1,'VD Outlet 2')`, out2)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,10)`, out2, other, size)
		o2, dup, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: "vd-sale-" + newID("4"), OrderUUID: newID("4"), OutletID: out2,
			CashierID: cashier, CashierName: "VD Kasir",
			Items:         []service.OrderItem{{ProductID: other, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000}},
			PaymentMethod: "cash", AmountPaid: 100000,
		})
		if err != nil || dup {
			t.Fatalf("outlet 2 sale: dup=%v err=%v", dup, err)
		}
		in2 := voidIn(o2, "")
		in2.OutletID, in2.Source, in2.CanVoidOwnShift, in2.CanVoidAny = out2, service.VoidSourceBackoffice, false, true
		if _, err := svc.VoidOrder(ctx, in2); err != nil {
			t.Fatal(err)
		}

		rows, _, err := rd.MovementSummary(ctx, "outlet", outlet, from, to, 1, 5000)
		if err != nil {
			t.Fatal(err)
		}
		byProduct := map[string]struct{ sold, refunded int }{}
		for _, r := range rows {
			byProduct[r.ProductId.String()] = struct{ sold, refunded int }{r.Sold, r.Refunded}
		}
		if got := byProduct[x]; got.sold != 2 || got.refunded != 2 {
			t.Fatalf("x sold/refunded = %+v, want 2/2 (the void counts once, at void time)", got)
		}
		if got := byProduct[cp]; got.sold != 1 || got.refunded != 0 {
			t.Fatalf("a skip_counted line sold/refunded = %+v, want 1/0", got)
		}
		if got := byProduct[giveaway]; got.sold != 0 || got.refunded != 0 {
			t.Fatalf("the giveaway sold/refunded = %+v, want 0/0 (not an order item)", got)
		}
		if got := byProduct[other]; got.sold != 0 || got.refunded != 0 {
			t.Fatalf("another outlet's voided order leaked: %+v", got)
		}
	})
}
