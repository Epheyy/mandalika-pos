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

	t.Run("void_enqueues_pending", func(t *testing.T) {
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
		// Every void-related document enqueues as a plain pending row now (migration 0094).
		for _, k := range []string{voidDoc, "sale:vd-erp-repl", "refund:vd-erp-repl", otherDoc} {
			if r := get(k); r.status != "pending" || r.hold != "" {
				t.Fatalf("%s outbox = %+v, want pending with no hold reason", k, r)
			}
		}

		// The void row builds as a refund on the wire.
		var h erp.OutboxHeader
		var part, partCount int
		if err := pool.QueryRow(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
		    COALESCE(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE doc_key=$1`, voidDoc).Scan(
			&h.ID, &h.DocumentID, &h.Kind, &h.LocationType, &h.LocationID, &h.RefType, &h.RefID, &h.RefNumber, &part, &partCount, &h.CreatedAt); err != nil {
			t.Fatal(err)
		}
		h.Part, h.PartCount = part, partCount
		if h.Kind != "void" {
			t.Fatalf("void outbox kind = %q, want the internal kind void", h.Kind)
		}
		in, err := erp.LoadBuildInput(ctx, pool, h, "mandalika")
		if err != nil {
			t.Fatalf("LoadBuildInput(void): %v", err)
		}
		if in.Order == nil {
			t.Fatal("LoadBuildInput(void) did not load the original order")
		}
		in.LocationCode = "VD-1"
		for i := range in.Movements {
			in.Movements[i].FgCode = "FG-VD"
		}
		doc, hold, err := erp.BuildDocument(in)
		if err != nil || hold != "" {
			t.Fatalf("BuildDocument(void): hold=%q err=%v", hold, err)
		}
		if doc.Kind != "refund" || doc.Ref.Type != "void" || doc.Ref.ID != origO || doc.Lines[0].Qty <= 0 {
			t.Fatalf("void wire document = kind %s ref %+v qty %d, want refund/void/%s/>0", doc.Kind, doc.Ref, doc.Lines[0].Qty, origO)
		}
		if len(doc.Tenders) != 1 || doc.Tenders[0].Amount != -1000 {
			t.Fatalf("void tenders = %+v, want the sale's cash negated", doc.Tenders)
		}

		if items, _, err := erp.List(ctx, pool, "", "void", 50, 0); err != nil || len(items) == 0 {
			t.Fatalf("erp.List kind=void = %d items, %v", len(items), err)
		}
	})

	t.Run("void_erp_released", func(t *testing.T) {
		// Rows Void phase 1 parked before migration 0094 (the migration ran on an empty database).
		exec(`UPDATE erp_outbox SET status='held', hold_reason='void_erp_pending', next_attempt_at=now() + interval '1 day'
		       WHERE doc_key IN ('void:vd-erp-held','sale:vd-erp-repl','refund:vd-erp-repl')`)
		exec(`UPDATE erp_outbox SET status='held', hold_reason='outlet belum terhubung ke ERP' WHERE doc_key='sale:vd-erp-plain'`)
		raw, err := os.ReadFile(filepath.Join("..", "db", "migrations", "0094_void_erp_release.sql"))
		if err != nil {
			t.Fatal(err)
		}
		exec(string(raw))
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM erp_outbox WHERE hold_reason='void_erp_pending'`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rows still holding void_erp_pending = %d, %v", n, err)
		}
		for _, k := range []string{"void:vd-erp-held", "sale:vd-erp-repl", "refund:vd-erp-repl"} {
			var st, hold string
			var due bool
			if err := pool.QueryRow(ctx, `SELECT status, COALESCE(hold_reason,''), next_attempt_at <= now() FROM erp_outbox WHERE doc_key=$1`, k).Scan(&st, &hold, &due); err != nil {
				t.Fatal(err)
			}
			if st != "pending" || hold != "" || !due {
				t.Fatalf("%s after 0094 = %s/%s due=%v, want pending, no hold, due now", k, st, hold, due)
			}
		}
		// A hold for another reason is left alone.
		var st string
		if err := pool.QueryRow(ctx, `SELECT status FROM erp_outbox WHERE doc_key='sale:vd-erp-plain'`).Scan(&st); err != nil || st != "held" {
			t.Fatalf("an unrelated hold changed to %q, %v", st, err)
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
		shift, cust, code, tenders string
		earned, redeemed           int
		offline                    bool
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
			PaymentMethod: "cash", AmountPaid: total, ShiftID: o.shift, Offline: o.offline,
			Tenders: json.RawMessage(o.tenders),
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
		if n := one(`SELECT count(*) FROM erp_outbox WHERE doc_key=$1 AND status='pending'`, "void:"+res.VoidID); n != 1 {
			t.Fatalf("pending void outbox rows = %d, want 1", n)
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

	// ── Phase 2, Task 2.3: replacement and closed-shift corrections ─────────────────────────
	bo := func(orderID string) service.VoidInput {
		in := voidIn(orderID, "")
		in.Source, in.CanVoidOwnShift, in.CanVoidAny = service.VoidSourceBackoffice, false, true
		in.DeviceID = ""
		in.ClientVoidUUID = ""
		return in
	}
	// replIn builds a replacement cart of the given products (100000 each) paid by tendersJSON.
	replIn := func(tendersJSON string, pids ...string) service.CreateOrderInput {
		var items []service.OrderItem
		for _, pid := range pids {
			items = append(items, service.OrderItem{ProductID: pid, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000})
		}
		return service.CreateOrderInput{
			IdempotencyKey: "vd-repl-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
			CashierID: cashier, CashierName: "VD Kasir", Items: items, Offline: true,
			Tenders: json.RawMessage(tendersJSON),
		}
	}
	corrections := func(shift string) string {
		return str(`SELECT COALESCE(string_agg(kind||':'||method||':'||amount::bigint::text, ',' ORDER BY kind DESC, method, amount), '')
		              FROM shift_corrections WHERE shift_id=$1`, shift)
	}
	snapshot := func(shift string) string {
		return str(`SELECT concat_ws('|', total_sales::text, total_orders::text, cash_sales::text, card_sales::text,
		                  transfer_sales::text, qris_sales::text, closing_cash::text, total_refunds::text,
		                  refunds_paid_by_method::text, cash_refunds_paid::text) FROM shifts WHERE id=$1`, shift)
	}
	splitSale := func(shift string, pids ...string) string {
		return sale(saleOpts{shift: shift, tenders: `[{"method":"cash","amount":100000},{"method":"qris","amount":200000}]`}, pids...)
	}

	t.Run("void_replace_atomic_open_shift", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift}, ps...)
		in := voidIn(id, shift)
		in.Mode = service.VoidModeReplace
		res, err := svc.VoidAndReplace(ctx, in, replIn(`[{"method":"qris","amount":300000}]`, ps...))
		if err != nil || res.ReplacementOrderID == "" {
			t.Fatalf("res=%+v err=%v", res, err)
		}
		if status(id) != "cancelled" || status(res.ReplacementOrderID) != "completed" {
			t.Fatalf("statuses %s / %s", status(id), status(res.ReplacementOrderID))
		}
		if got := str(`SELECT replaces_order_id::text FROM orders WHERE id=$1`, res.ReplacementOrderID); got != id {
			t.Fatalf("replaces_order_id = %s", got)
		}
		if str(`SELECT shift_id::text FROM orders WHERE id=$1`, res.ReplacementOrderID) != shift ||
			str(`SELECT business_date::text FROM orders WHERE id=$1`, res.ReplacementOrderID) != str(`SELECT business_date::text FROM orders WHERE id=$1`, id) {
			t.Fatal("replacement not pinned to the original's shift and day")
		}
		if got := str(`SELECT replacement_order_id::text FROM order_voids WHERE id=$1`, res.VoidID); got != res.ReplacementOrderID {
			t.Fatalf("audit replacement link = %s", got)
		}
		for _, p := range ps {
			if stockOf(p) != 4 { // restocked to 5 by the void, then sold again
				t.Fatalf("stock = %d, want 4", stockOf(p))
			}
		}
		closeShift(shift)
		if got := snapshot(shift); !strings.HasPrefix(got, "300000.00|1|0.00|") || !strings.Contains(got, "|300000.00|") {
			t.Fatalf("close snapshot = %s, want cash 0, qris 300000, 1 order", got)
		}
		if corrections(shift) != "" {
			t.Fatal("an open-shift void wrote corrections")
		}
	})

	t.Run("void_replace_refused_rolls_back_both", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := voidIn(id, shift)
		in.Mode = service.VoidModeReplace
		bad := replIn(`[{"method":"cash","amount":100000}]`, p)
		bad.Items[0].Quantity = -1 // rejected inside the sale core, after the void already wrote
		if _, err := svc.VoidAndReplace(ctx, in, bad); err == nil {
			t.Fatal("invalid replacement accepted")
		}
		if status(id) != "completed" || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 0 || stockOf(p) != 4 {
			t.Fatalf("partial apply: status=%s stock=%d", status(id), stockOf(p))
		}
	})

	t.Run("void_replace_closed_shift_deltas", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := splitSale(shift, ps...)
		closeShift(shift)
		before := snapshot(shift)
		res, err := svc.VoidAndReplace(ctx, func() service.VoidInput { in := bo(id); in.Mode = service.VoidModeReplace; return in }(),
			replIn(`[{"method":"qris","amount":300000}]`, ps...))
		if err != nil || !res.AfterClose {
			t.Fatalf("res=%+v err=%v", res, err)
		}
		if got := corrections(shift); got != "void:cash:-100000,void:qris:-200000,replacement:qris:300000" {
			t.Fatalf("corrections = %s", got)
		}
		if snapshot(shift) != before {
			t.Fatal("the close snapshot changed") // closed_shift_snapshot_unchanged
		}
		if !strings.Contains(str(`SELECT after_close::text||counted_in_close::text FROM order_voids WHERE id=$1`, res.VoidID), "truetrue") {
			t.Fatal("after_close / counted_in_close not set")
		}
	})

	t.Run("void_any_closed_shift_void_only_delta", func(t *testing.T) {
		shift := openShift()
		id := splitSale(shift, product(5), product(5), product(5))
		closeShift(shift)
		if _, err := svc.VoidOrder(ctx, bo(id)); err != nil {
			t.Fatal(err)
		}
		if got := corrections(shift); got != "void:cash:-100000,void:qris:-200000" {
			t.Fatalf("corrections = %s", got)
		}
	})

	t.Run("late_sale_void_no_delta", func(t *testing.T) {
		shift := openShift()
		closeShift(shift)
		id := sale(saleOpts{shift: shift, offline: true}, product(5))
		if str(`SELECT (created_at > (SELECT closed_at FROM shifts WHERE id=$1))::text FROM orders WHERE id=$2`, shift, id) != "true" {
			t.Fatal("setup: the sale is not late")
		}
		res, err := svc.VoidOrder(ctx, bo(id))
		if err != nil {
			t.Fatal(err)
		}
		if corrections(shift) != "" {
			t.Fatalf("a late sale wrote corrections: %s", corrections(shift))
		}
		if got := str(`SELECT after_close::text||counted_in_close::text FROM order_voids WHERE id=$1`, res.VoidID); got != "truefalse" {
			t.Fatalf("after_close/counted = %s, want truefalse", got)
		}
	})

	t.Run("later_void_open_replaced_after_close", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p, product(5), product(5))
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		if corrections(shift) != "" {
			t.Fatal("a void while the shift is open wrote corrections")
		}
		closeShift(shift)
		if got := snapshot(shift); !strings.HasPrefix(got, "0.00|0|") {
			t.Fatalf("snapshot should exclude the cancelled sale: %s", got)
		}
		r := replIn(`[{"method":"qris","amount":300000}]`, p, product(5), product(5))
		r.ReplacesOrderID = id
		got, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil || got.OrderID == "" {
			t.Fatalf("buat pengganti: %+v %v", got, err)
		}
		if c := corrections(shift); c != "replacement:qris:300000" {
			t.Fatalf("corrections = %s, want only the replacement +row", c)
		}
		if str(`SELECT shift_id::text FROM orders WHERE id=$1`, got.OrderID) != shift {
			t.Fatal("replacement not on the original's shift")
		}
	})

	t.Run("void_replacement_on_closed_shift", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift}, ps...)
		closeShift(shift)
		in := bo(id)
		in.Mode = service.VoidModeReplace
		res, err := svc.VoidAndReplace(ctx, in, replIn(`[{"method":"qris","amount":300000}]`, ps...))
		if err != nil {
			t.Fatal(err)
		}
		if got := corrections(shift); got != "void:cash:-300000,replacement:qris:300000" {
			t.Fatalf("after replace: %s", got)
		}
		if _, err := svc.VoidOrder(ctx, bo(res.ReplacementOrderID)); err != nil {
			t.Fatalf("void of the replacement: %v", err)
		}
		if got := corrections(shift); got != "void:cash:-300000,void:qris:-300000,replacement:qris:300000" {
			t.Fatalf("after voiding the replacement: %s", got)
		}
	})

	t.Run("replacement_amounts_fixed_after_close", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift}, ps...)
		closeShift(shift)
		in := bo(id)
		in.Mode = service.VoidModeReplace
		_, err := svc.VoidAndReplace(ctx, in, replIn(`[{"method":"cash","amount":320000}]`, ps...))
		if err == nil || !strings.Contains(err.Error(), "Rp 300.000") {
			t.Fatalf("err = %v, want the amounts-locked refusal naming Rp 300.000", err)
		}
		if status(id) != "completed" {
			t.Fatal("refused void changed the order")
		}

		// Own shift, still open: amounts are editable; the gap becomes "Penyesuaian koreksi".
		shift2 := openShift()
		id2 := sale(saleOpts{shift: shift2}, ps...)
		in2 := voidIn(id2, shift2)
		in2.Mode = service.VoidModeReplace
		r := replIn(`[{"method":"cash","amount":300000}]`, ps...)
		r.Items = r.Items[:1]
		r.Items[0].Price, r.Items[0].Subtotal = 320000, 320000
		in2.ReplacementAtOriginalTotal = true
		res, err := svc.VoidAndReplace(ctx, in2, r)
		if err != nil {
			t.Fatal(err)
		}
		if got := one(`SELECT correction_amount::int FROM orders WHERE id=$1`, res.ReplacementOrderID); got != -20000 {
			t.Fatalf("correction_amount = %d, want -20000", got)
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, res.ReplacementOrderID); got != 300000 {
			t.Fatalf("total = %d, want 300000", got)
		}
	})

	t.Run("salah_pelanggan_moves_visit", func(t *testing.T) {
		shift := openShift()
		a, b := customer(0), customer(0)
		p := product(5)
		id := sale(saleOpts{shift: shift, cust: a}, p)
		visits := func(c string) int { return one(`SELECT visit_count FROM customers WHERE id=$1`, c) }
		aBefore, bBefore := visits(a), visits(b)
		in := voidIn(id, shift)
		in.Mode, in.Reason = service.VoidModeReplace, service.VoidReasonWrongCustomer
		r := replIn(`[{"method":"cash","amount":100000}]`, p)
		r.CustomerID = b
		if _, err := svc.VoidAndReplace(ctx, in, r); err != nil {
			t.Fatal(err)
		}
		if visits(a) != aBefore-1 || visits(b) != bBefore+1 {
			t.Fatalf("visits a=%d b=%d, want %d and %d", visits(a), visits(b), aBefore-1, bBefore+1)
		}
	})

	t.Run("buat_pengganti_later", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		r := replIn(`[{"method":"cash","amount":100000}]`, p)
		r.ReplacesOrderID = id
		if _, err := svc.CreateReplacementOrder(ctx, r, false, ""); !errors.Is(err, service.ErrVoidForbidden) {
			t.Fatalf("without void_any: %v", err)
		}
		got, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil || got.Duplicate {
			t.Fatalf("res=%+v err=%v", got, err)
		}
		if one(`SELECT count(*) FROM order_void_followups f JOIN order_voids v ON v.id=f.void_id WHERE v.order_id=$1 AND f.kind='replacement' AND f.replacement_order_id=$2`, id, got.OrderID) != 1 {
			t.Fatal("followup row missing")
		}
		// The same key again (a lost ack) is a duplicate with the stored id; a new key is refused.
		again, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil || !again.Duplicate || again.OrderID != got.OrderID {
			t.Fatalf("resend = %+v, %v", again, err)
		}
		r2 := replIn(`[{"method":"cash","amount":100000}]`, p)
		r2.ReplacesOrderID = id
		if _, err := svc.CreateReplacementOrder(ctx, r2, true, ""); !errors.Is(err, service.ErrVoidReplacementInvalid) {
			t.Fatalf("second replacement: %v", err)
		}
	})

	t.Run("no_replacement_mark", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		if err := svc.MarkVoidNoReplacement(ctx, outlet, id, adminU, "VD Admin", "tes"); err != nil {
			t.Fatal(err)
		}
		if one(`SELECT count(*) FROM order_void_followups f JOIN order_voids v ON v.id=f.void_id WHERE v.order_id=$1 AND f.kind='no_replacement'`, id) != 1 {
			t.Fatal("followup row missing")
		}
		if err := svc.MarkVoidNoReplacement(ctx, outlet, id, adminU, "VD Admin", ""); !errors.Is(err, service.ErrVoidReplacementInvalid) {
			t.Fatalf("second mark: %v", err)
		}
		r := replIn(`[{"method":"cash","amount":100000}]`, p)
		r.ReplacesOrderID = id
		if _, err := svc.CreateReplacementOrder(ctx, r, true, ""); !errors.Is(err, service.ErrVoidReplacementInvalid) {
			t.Fatalf("replacement after the mark: %v", err)
		}
	})

	t.Run("replacement_enqueues_pending", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := voidIn(id, shift)
		in.Mode = service.VoidModeReplace
		res, err := svc.VoidAndReplace(ctx, in, replIn(`[{"method":"cash","amount":100000}]`, p))
		if err != nil {
			t.Fatal(err)
		}
		var st, hold string
		if err := pool.QueryRow(ctx, `SELECT status, COALESCE(hold_reason,'') FROM erp_outbox WHERE doc_key=$1`, "sale:"+res.ReplacementOrderID).Scan(&st, &hold); err != nil {
			t.Fatal(err)
		}
		if st != "pending" || hold != "" {
			t.Fatalf("replacement sale outbox = %s/%s, want pending with no hold reason", st, hold)
		}
		if got := str(`SELECT status FROM erp_outbox WHERE doc_key=$1`, "sale:"+id); got == "held" {
			t.Fatalf("the original sale document was held")
		}
	})

	t.Run("concurrent_void_replace_and_sale_no_deadlock", func(t *testing.T) {
		exec(`INSERT INTO discount_codes(code, type, value, is_active) VALUES ('VDHEMAT','percentage',0,true) ON CONFLICT DO NOTHING`)
		shift := openShift()
		x, y := product(500), product(500)
		for round := 0; round < 20; round++ {
			id := sale(saleOpts{shift: shift, code: "VDHEMAT"}, y)
			in := voidIn(id, shift)
			in.Mode = service.VoidModeReplace
			r := replIn(`[{"method":"cash","amount":100000}]`, x)
			r.DiscountCodes = []string{"VDHEMAT"}
			var wg sync.WaitGroup
			var replErr, saleErr error
			wg.Add(2)
			go func() { defer wg.Done(); _, replErr = svc.VoidAndReplace(ctx, in, r) }()
			go func() {
				defer wg.Done()
				_, _, _, saleErr = svc.CreateOrder(ctx, service.CreateOrderInput{
					IdempotencyKey: "vd-conc-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
					CashierID: cashier, CashierName: "VD Kasir", ShiftID: shift, PaymentMethod: "cash", AmountPaid: 200000,
					DiscountCodes: []string{"VDHEMAT"},
					Items: []service.OrderItem{
						{ProductID: x, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000},
						{ProductID: y, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000},
					},
				})
			}()
			wg.Wait()
			for _, e := range []error{replErr, saleErr} {
				var pg *pgconn.PgError
				if errors.As(e, &pg) && pg.Code == "40P01" {
					t.Fatalf("round %d: deadlock: %v", round, e)
				}
			}
			if replErr != nil || saleErr != nil {
				t.Fatalf("round %d: replace err=%v sale err=%v", round, replErr, saleErr)
			}
		}
	})

	t.Run("concurrent_void_replace_and_sale_no_deadlock_no_code", func(t *testing.T) {
		shift := openShift()
		x, y := product(500), product(500)
		for round := 0; round < 20; round++ {
			id := sale(saleOpts{shift: shift}, y)
			in := voidIn(id, shift)
			in.Mode = service.VoidModeReplace
			r := replIn(`[{"method":"cash","amount":100000}]`, x)
			var wg sync.WaitGroup
			var replErr, saleErr error
			wg.Add(2)
			go func() { defer wg.Done(); _, replErr = svc.VoidAndReplace(ctx, in, r) }()
			go func() {
				defer wg.Done()
				_, _, _, saleErr = svc.CreateOrder(ctx, service.CreateOrderInput{
					IdempotencyKey: "vd-conc-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
					CashierID: cashier, CashierName: "VD Kasir", ShiftID: shift, PaymentMethod: "cash", AmountPaid: 200000,
					Items: []service.OrderItem{
						{ProductID: x, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000},
						{ProductID: y, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000},
					},
				})
			}()
			wg.Wait()
			for _, e := range []error{replErr, saleErr} {
				var pg *pgconn.PgError
				if errors.As(e, &pg) && pg.Code == "40P01" {
					t.Fatalf("round %d: deadlock: %v", round, e)
				}
			}
			if replErr != nil || saleErr != nil {
				t.Fatalf("round %d: replace err=%v sale err=%v", round, replErr, saleErr)
			}
		}
	})

	t.Run("void_replace_direct_replay", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := bo(id)
		in.Mode, in.DeviceID, in.ClientVoidUUID = service.VoidModeReplace, "vd-bo-dev", newID("4")
		r := replIn(`[{"method":"qris","amount":100000}]`, p)
		first, err := svc.VoidAndReplace(ctx, in, r)
		if err != nil {
			t.Fatal(err)
		}
		again, err := svc.VoidAndReplace(ctx, in, r)
		if err != nil || !again.Replayed || again.VoidID != first.VoidID || again.ReplacementOrderID != first.ReplacementOrderID {
			t.Fatalf("replay = %+v, %v (first %+v)", again, err, first)
		}
		if one(`SELECT count(*) FROM orders WHERE replaces_order_id=$1`, id) != 1 {
			t.Fatal("replay created a second replacement")
		}
	})

	t.Run("void_chain", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := voidIn(id, shift)
		in.Mode = service.VoidModeReplace
		first, err := svc.VoidAndReplace(ctx, in, replIn(`[{"method":"cash","amount":100000}]`, p))
		if err != nil {
			t.Fatal(err)
		}
		in2 := voidIn(first.ReplacementOrderID, shift)
		in2.Mode = service.VoidModeReplace
		second, err := svc.VoidAndReplace(ctx, in2, replIn(`[{"method":"cash","amount":100000}]`, p))
		if err != nil {
			t.Fatal(err)
		}
		if got := str(`SELECT replaces_order_id::text FROM orders WHERE id=$1`, second.ReplacementOrderID); got != first.ReplacementOrderID {
			t.Fatalf("chain link = %s", got)
		}
		if status(id) != "cancelled" || status(first.ReplacementOrderID) != "cancelled" || status(second.ReplacementOrderID) != "completed" {
			t.Fatal("chain statuses wrong")
		}
	})

	t.Run("shift_corrections_append_only", func(t *testing.T) {
		shift := openShift()
		id := sale(saleOpts{shift: shift}, product(5))
		res, err := svc.VoidOrder(ctx, voidIn(id, shift))
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO shift_corrections(shift_id,void_id,order_id,kind,method,amount) VALUES($1,$2,$3,'void','cash',-100000)`, shift, res.VoidID, id)
		for _, q := range []string{`UPDATE shift_corrections SET amount=-1`, `DELETE FROM shift_corrections`} {
			if _, err := pool.Exec(ctx, q); err == nil || !strings.Contains(err.Error(), "append-only") {
				t.Fatalf("%s: err = %v, want the append-only trigger", q, err)
			}
		}
		for name, q := range map[string]string{
			"amount_nonzero": `INSERT INTO shift_corrections(shift_id,void_id,order_id,kind,method,amount) VALUES($1,$2,$3,'replacement','qris',0)`,
			"unique_row":     `INSERT INTO shift_corrections(shift_id,void_id,order_id,kind,method,amount) VALUES($1,$2,$3,'void','cash',-5)`,
			"kind_check":     `INSERT INTO shift_corrections(shift_id,void_id,order_id,kind,method,amount) VALUES($1,$2,$3,'other','cash',-5)`,
		} {
			if _, err := pool.Exec(ctx, q, shift, res.VoidID, id); err == nil {
				t.Fatalf("%s: insert accepted", name)
			}
		}
	})

	t.Run("replacement_business_date_kept", func(t *testing.T) {
		pid := product(5)
		orig := sale(saleOpts{}, product(5))
		target := int64(95000)
		id, dup, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: "vd-repl-bd-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
			CashierID: cashier, CashierName: "VD Kasir", ReplacesOrderID: orig, BusinessDate: "2026-11-05",
			CorrectionTarget: &target, PaymentMethod: "cash", AmountPaid: 95000, Offline: true,
			Items: []service.OrderItem{{ProductID: pid, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000}},
		})
		if err != nil || dup {
			t.Fatalf("replacement: dup=%v err=%v", dup, err)
		}
		if got := str(`SELECT business_date::text FROM orders WHERE id=$1`, id); got != "2026-11-05" {
			t.Fatalf("business_date = %s, want 2026-11-05", got)
		}
		if got := str(`SELECT replaces_order_id::text FROM orders WHERE id=$1`, id); got != orig {
			t.Fatalf("replaces_order_id = %s", got)
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, id); got != 95000 {
			t.Fatalf("total = %d, want the target 95000", got)
		}
		if got := one(`SELECT correction_amount::int FROM orders WHERE id=$1`, id); got != -5000 {
			t.Fatalf("correction_amount = %d, want -5000", got)
		}
		if got := one(`SELECT COALESCE(sum(net_amount),0)::int FROM order_items WHERE order_id=$1`, id); got != 95000 {
			t.Fatalf("line nets sum = %d, want 95000", got)
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
	router.With(mw.RequirePermission("void_any")).Post("/orders/{id}/void/no-replacement", h.MarkVoidNoReplacement)
	router.Get("/shifts", h.Shifts)
	router.With(mw.RequirePermission("view_reports")).Get("/void-report", h.VoidReport)
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

	// ── Phase 2, Task 2.4: sync ────────────────────────────────────────────────────────────
	replPayload := func(tendersJSON string, extra map[string]any, pids ...string) map[string]any {
		items := []any{}
		for _, pid := range pids {
			items = append(items, map[string]any{"productId": pid, "productName": "VD", "variantSize": size, "price": 100000, "quantity": 1, "subtotal": 100000})
		}
		var tenders any
		_ = json.Unmarshal([]byte(tendersJSON), &tenders)
		m := map[string]any{"orderUuid": newID("4"), "items": items, "tenders": tenders}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	replaceItem := func(shift, orderID string, repl map[string]any) map[string]any {
		return voidItem(shift, orderID, map[string]any{"mode": "replace", "replacement": repl})
	}

	t.Run("sync_void_replace_ok", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift}, ps...)
		res := sendItem(cashierTok, replaceItem(shift, id, replPayload(`[{"method":"qris","amount":300000}]`, nil, ps...)))
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || res["orderId"] != id || repl == "" {
			t.Fatalf("result = %v, want ok with both ids", res)
		}
		if status(id) != "cancelled" || status(repl) != "completed" ||
			str(`SELECT replaces_order_id::text FROM orders WHERE id=$1`, repl) != id {
			t.Fatal("void/replacement not applied together")
		}
	})

	t.Run("sync_void_replace_replay", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		item := replaceItem(shift, id, replPayload(`[{"method":"cash","amount":100000}]`, nil, p))
		first := sendItem(cashierTok, item)
		stock := stockOf(p)
		again := sendItem(cashierTok, item)
		if again["status"] != "ok" || again["orderId"] != id || again["replacementOrderId"] != first["replacementOrderId"] {
			t.Fatalf("replay = %v, first %v", again, first)
		}
		if stockOf(p) != stock || one(`SELECT count(*) FROM orders WHERE replaces_order_id=$1`, id) != 1 {
			t.Fatal("replay applied again")
		}
	})

	t.Run("offline_own_shift_after_close_refused", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		item := replaceItem(shift, id, replPayload(`[{"method":"cash","amount":100000}]`, nil, p))
		closeShift(shift)
		res := sendItem(cashierTok, item)
		if res["status"] != "error" || res["code"] != "forbidden" || res["retryable"] != false {
			t.Fatalf("result = %v, want a non-retryable forbidden", res)
		}
		if status(id) != "completed" || one(`SELECT count(*) FROM orders WHERE replaces_order_id=$1`, id) != 0 {
			t.Fatal("a refused item applied something")
		}
		if again := sendItem(cashierTok, item); again["status"] != "error" || again["code"] != "forbidden" {
			t.Fatalf("retry = %v, want the same refusal", again)
		}
	})

	t.Run("replacement_bundle_revalidated", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift}, ps...)
		repl := replPayload(`[{"method":"cash","amount":300000}]`, nil, ps...)
		for i, role := range []string{"large", "atomizer", "vial"} {
			it := repl["items"].([]any)[i].(map[string]any)
			it["bundleGroup"], it["bundleRole"], it["bundlePrice"], it["bundleBasisPrice"] = 1, role, 300000, 300000
		}
		res := sendItem(cashierTok, replaceItem(shift, id, repl))
		rid, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || rid == "" {
			t.Fatalf("result = %v, want the invalid bundle kept", res)
		}
		if got := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, rid); !strings.Contains(got, "bundle_invalid") {
			t.Fatalf("reason = %q, want bundle_invalid", got)
		}
	})

	t.Run("sync_buat_pengganti_needs_void_any", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		orderItemFor := func(token string) map[string]any {
			pl := replPayload(`[{"method":"cash","amount":100000}]`, map[string]any{"replacesOrderId": id}, p)
			uid := pl["orderUuid"].(string)
			return map[string]any{"type": "order", "idempotencyKey": syncDevice + ":" + uid, "payload": pl,
				"envelope": map[string]any{"v": 1, "outletId": outlet, "userId": cashier, "deviceId": syncDevice, "capturedAt": time.Now().UTC().Format(time.RFC3339), "shiftId": shift}}
		}
		item := orderItemFor("")
		if res := sendItem(cashierTok, item); res["status"] != "error" || res["code"] != "forbidden" {
			t.Fatalf("without void_any: %v", res)
		}
		anyTok := tok(cashier, "manager", []string{"void_any"})
		first := sendItem(anyTok, item)
		if first["status"] != "ok" || first["orderId"] == "" {
			t.Fatalf("with void_any: %v", first)
		}
		// sync_buat_pengganti_replay: the same item again, even without the permission, is a duplicate.
		again := sendItem(cashierTok, item)
		if again["status"] != "duplicate" || again["orderId"] != first["orderId"] {
			t.Fatalf("replay = %v, want duplicate with the stored id", again)
		}
	})

	// ── Owner rule "deduct written-off": a replacement for the SAME customer earns
	// max(0, normal earn - the void's points_forgiven) ───────────────────────────────────────
	withLoyalty := func(t *testing.T) {
		t.Helper()
		var en bool
		var ppk float64
		if err := pool.QueryRow(ctx, `SELECT enabled, points_per_thousand FROM loyalty_settings WHERE id=1`).Scan(&en, &ppk); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1 WHERE id=1`)
		t.Cleanup(func() { exec(`UPDATE loyalty_settings SET enabled=$1, points_per_thousand=$2 WHERE id=1`, en, ppk) })
	}
	// pointsSale rings a 100000 sale for cust that "earned" earn points, with the customer's balance
	// then set to balance (the rest was spent), before loyalty is switched on for the replacement.
	pointsSale := func(shift, cust string, earn, balance int, p string) string {
		id := sale(saleOpts{shift: shift, cust: cust, earned: earn}, p)
		exec(`UPDATE customers SET points=$2 WHERE id=$1`, cust, balance)
		return id
	}
	earnRows := func(order string) (int, string) {
		return one(`SELECT COALESCE(sum(points),0)::int FROM point_transactions WHERE order_id=$1 AND type='earn'`, order),
			str(`SELECT COALESCE(string_agg(reason, ' | '),'') FROM point_transactions WHERE order_id=$1 AND type='earn'`, order)
	}

	t.Run("replacement_points_deducted", func(t *testing.T) {
		cases := []struct {
			name           string
			balance        int  // customer balance at the void (earned 100)
			otherCustomer  bool // the replacement is for a different customer
			wantForgiven   int
			wantReplEarned int
		}{
			{"fully_spent", 0, false, 100, 0},
			{"partly_spent", 70, false, 30, 70},
			{"nothing_forgiven", 100, false, 0, 100},
			{"different_customer", 0, true, 100, 100},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				shift := openShift()
				cust, other := customer(0), customer(0)
				p := product(5)
				id := pointsSale(shift, cust, 100, c.balance, p)
				withLoyalty(t)
				in := voidIn(id, shift)
				in.Mode = service.VoidModeReplace
				r := replIn(`[{"method":"cash","amount":100000}]`, p)
				r.CustomerID = cust
				if c.otherCustomer {
					r.CustomerID = other
				}
				res, err := svc.VoidAndReplace(ctx, in, r)
				if err != nil {
					t.Fatal(err)
				}
				if got := one(`SELECT points_forgiven FROM order_voids WHERE id=$1`, res.VoidID); got != c.wantForgiven {
					t.Fatalf("forgiven = %d, want %d", got, c.wantForgiven)
				}
				if got := one(`SELECT points_earned FROM orders WHERE id=$1`, res.ReplacementOrderID); got != c.wantReplEarned {
					t.Fatalf("replacement points_earned = %d, want %d", got, c.wantReplEarned)
				}
				wantDeducted := 100 - c.wantReplEarned
				if c.otherCustomer {
					wantDeducted = 0
				}
				if got := one(`SELECT replacement_points_deducted FROM order_voids WHERE id=$1`, res.VoidID); got != wantDeducted {
					t.Fatalf("audit deducted = %d, want %d", got, wantDeducted)
				}
				// The ledger earn row and the balance agree with the order.
				ledger, reason := earnRows(res.ReplacementOrderID)
				if ledger != c.wantReplEarned {
					t.Fatalf("ledger earn = %d, want %d", ledger, c.wantReplEarned)
				}
				if wantDeducted > 0 && c.wantReplEarned > 0 && !strings.Contains(reason, "dikurangi") {
					t.Fatalf("earn reason %q does not mention the deduction", reason)
				}
				who := cust
				wantBalance := c.wantReplEarned // the void clawed whatever was left
				if c.otherCustomer {
					who, wantBalance = other, c.wantReplEarned
				}
				if got := pointsOf(who); got != wantBalance {
					t.Fatalf("balance = %d, want %d", got, wantBalance)
				}
			})
		}
	})

	t.Run("replacement_points_deducted_chain", func(t *testing.T) {
		// Sale earns 100, all spent. Void 1 writes off 100 and Repl 1 earns 0. Voiding Repl 1 claws
		// nothing, so the write-off must carry to Repl 2: the customer ends at 0, not 100.
		shift := openShift()
		cust := customer(0)
		p := product(5)
		id := pointsSale(shift, cust, 100, 0, p)
		withLoyalty(t)
		in := voidIn(id, shift)
		in.Mode = service.VoidModeReplace
		r := replIn(`[{"method":"cash","amount":100000}]`, p)
		r.CustomerID = cust
		first, err := svc.VoidAndReplace(ctx, in, r)
		if err != nil {
			t.Fatal(err)
		}
		in2 := voidIn(first.ReplacementOrderID, shift)
		in2.Mode = service.VoidModeReplace
		r2 := replIn(`[{"method":"cash","amount":100000}]`, p)
		r2.CustomerID = cust
		second, err := svc.VoidAndReplace(ctx, in2, r2)
		if err != nil {
			t.Fatal(err)
		}
		if got := one(`SELECT points_earned FROM orders WHERE id=$1`, second.ReplacementOrderID); got != 0 {
			t.Fatalf("Repl 2 points_earned = %d, want 0", got)
		}
		if got := one(`SELECT replacement_points_deducted FROM order_voids WHERE id=$1`, second.VoidID); got != 100 {
			t.Fatalf("chain deducted = %d, want 100", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_deducted_sync", func(t *testing.T) {
		shift := openShift()
		cust := customer(0)
		p := product(5)
		id := pointsSale(shift, cust, 80, 0, p)
		withLoyalty(t)
		res := sendItem(cashierTok, replaceItem(shift, id, replPayload(`[{"method":"cash","amount":100000}]`, map[string]any{"customerId": cust}, p)))
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || repl == "" {
			t.Fatalf("result = %v", res)
		}
		// earned 80, balance 0: 80 forgiven; the replacement's normal 100 earns 20.
		if got := one(`SELECT points_earned FROM orders WHERE id=$1`, repl); got != 20 {
			t.Fatalf("replacement points_earned = %d, want 20", got)
		}
		if got := one(`SELECT replacement_points_deducted FROM order_voids WHERE order_id=$1`, id); got != 80 {
			t.Fatalf("audit deducted = %d, want 80", got)
		}
		if got := pointsOf(cust); got != 20 {
			t.Fatalf("balance = %d, want 20", got)
		}
	})

	t.Run("replacement_points_deducted_chain_sync", func(t *testing.T) {
		// O1 earned 80, all spent: V1 writes off 80. R1 (a smaller cart) would earn 50, so it deducts
		// only 50 and earns 0. R1 is voided and replaced by R2 (normal earn 80): the outstanding
		// write-off is still the full 80, not R1's 50, so R2 earns 0 and the customer stays at 0.
		shift := openShift()
		cust := customer(0)
		p := product(5)
		id := pointsSale(shift, cust, 80, 0, p)
		withLoyalty(t)
		cart := func(price int) map[string]any {
			r := replPayload(fmt.Sprintf(`[{"method":"cash","amount":%d}]`, price), map[string]any{"customerId": cust}, p)
			it := r["items"].([]any)[0].(map[string]any)
			it["price"], it["subtotal"] = price, price
			return r
		}
		first := sendItem(cashierTok, replaceItem(shift, id, cart(50000)))
		r1, _ := first["replacementOrderId"].(string)
		if first["status"] != "ok" || r1 == "" || one(`SELECT points_earned FROM orders WHERE id=$1`, r1) != 0 {
			t.Fatalf("R1 = %v, want ok and earning 0", first)
		}
		if got := one(`SELECT replacement_points_deducted FROM order_voids WHERE order_id=$1`, id); got != 50 {
			t.Fatalf("R1 deducted = %d, want 50", got)
		}
		if got := one(`SELECT replacement_points_writeoff FROM order_voids WHERE order_id=$1`, id); got != 80 {
			t.Fatalf("R1 write-off requested = %d, want 80", got)
		}
		second := sendItem(cashierTok, replaceItem(shift, r1, cart(80000)))
		r2, _ := second["replacementOrderId"].(string)
		if second["status"] != "ok" || r2 == "" {
			t.Fatalf("R2 = %v", second)
		}
		if got := one(`SELECT points_earned FROM orders WHERE id=$1`, r2); got != 0 {
			t.Fatalf("R2 points_earned = %d, want 0 (the full 80 is still written off)", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("buat_pengganti_points_deducted", func(t *testing.T) {
		shift := openShift()
		cust := customer(0)
		p := product(5)
		id := pointsSale(shift, cust, 100, 40, p) // 40 left: clawed, 60 forgiven
		in := bo(id)
		in.Mode = service.VoidModeLater
		res, err := svc.VoidOrder(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		withLoyalty(t)
		r := replIn(`[{"method":"cash","amount":100000}]`, p)
		r.ReplacesOrderID, r.CustomerID = id, cust
		got, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil {
			t.Fatal(err)
		}
		if e := one(`SELECT points_earned FROM orders WHERE id=$1`, got.OrderID); e != 40 {
			t.Fatalf("replacement points_earned = %d, want 40 (100 - 60 forgiven)", e)
		}
		if d := one(`SELECT replacement_points_deducted FROM order_void_followups WHERE void_id=$1`, res.VoidID); d != 60 {
			t.Fatalf("followup deducted = %d, want 60", d)
		}
		if b := pointsOf(cust); b != 40 {
			t.Fatalf("balance = %d, want 40", b)
		}
	})

	// ── Owner rule "reuse redeemed points": the void restores a sale's redeemed points first and a
	// replacement for the SAME customer may redeem them again, whatever the balance has become ──
	withRedemption := func(t *testing.T) {
		t.Helper()
		withLoyalty(t)
		var rate float64
		if err := pool.QueryRow(ctx, `SELECT redemption_rate FROM loyalty_settings WHERE id=1`).Scan(&rate); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE loyalty_settings SET redemption_rate=100 WHERE id=1`) // 1 point = Rp100
		t.Cleanup(func() { exec(`UPDATE loyalty_settings SET redemption_rate=$1 WHERE id=1`, rate) })
	}
	// redeemScenario rings a 100000 sale that redeems 50 points (Rp5.000, so it took 95000 cash and
	// earned 100), then leaves the customer with `left` points (the rest was spent elsewhere).
	redeemScenario := func(t *testing.T, left int) (shift, cust, p, id string) {
		t.Helper()
		withRedemption(t)
		shift, cust, p = openShift(), customer(50), product(8)
		id, dup, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: "vd-redeem-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
			CashierID: cashier, CashierName: "VD Kasir", CustomerID: cust, PointsRedeemed: 50,
			Items:         []service.OrderItem{{ProductID: p, ProductName: "VD", VariantSize: size, Price: 100000, Quantity: 1, Subtotal: 100000}},
			PaymentMethod: "cash", AmountPaid: 95000, ShiftID: shift,
		})
		if err != nil || dup {
			t.Fatalf("redeem sale: dup=%v err=%v", dup, err)
		}
		if one(`SELECT points_redeemed FROM orders WHERE id=$1`, id) != 50 || one(`SELECT points_earned FROM orders WHERE id=$1`, id) != 100 || one(`SELECT total::int FROM orders WHERE id=$1`, id) != 95000 {
			t.Fatal("fixture sale did not redeem 50 / earn 100 / total 95000")
		}
		exec(`UPDATE customers SET points=$2 WHERE id=$1`, cust, left)
		return shift, cust, p, id
	}
	boReplace := func(id string) service.VoidInput {
		in := bo(id)
		in.Mode = service.VoidModeReplace
		return in
	}
	cashLines := `[{"method":"cash","amount":95000}]`
	replRedeem := func(p, cust string, redeem int) service.CreateOrderInput {
		r := replIn(cashLines, p)
		r.CustomerID, r.PointsRedeemed = cust, redeem
		return r
	}
	// booked reads what a replacement stored: points redeemed, points earned, correction amount.
	type replBooked struct{ redeemed, earned, correction int }
	booked := func(order string) replBooked {
		return replBooked{
			one(`SELECT points_redeemed FROM orders WHERE id=$1`, order),
			one(`SELECT points_earned FROM orders WHERE id=$1`, order),
			one(`SELECT correction_amount::int FROM orders WHERE id=$1`, order),
		}
	}
	ledgerOf := func(cust string) string {
		return str(`SELECT COALESCE(string_agg(type||':'||points||'>'||balance_after, ' | ' ORDER BY created_at, id),'') FROM point_transactions WHERE customer_id=$1`, cust)
	}

	t.Run("replacement_reuses_redeemed_points", func(t *testing.T) {
		// The customer spent the rest: balance 0. The void restores 50 and claws 50 of the 100 earned
		// (50 forgiven); the replacement earns 100-50 and redeems the same 50 again.
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, res.ReplacementOrderID); got != 95000 {
			t.Fatalf("replacement total = %d, want 95000", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
		ledger := ledgerOf(cust)
		// The void restores 50 (to 50) and claws 50 (to 0); the replacement then earns 50 and redeems 50
		// (rows of one transaction share a timestamp, so their order is not asserted).
		for _, row := range []string{"void:50>50", "void:-50>0", "earn:50>50", "redeem:-50>0"} {
			if !strings.Contains(ledger, row) {
				t.Fatalf("ledger = %s, missing %s", ledger, row)
			}
		}
	})

	t.Run("replacement_reuses_redeemed_points_untouched_balance", func(t *testing.T) {
		// Nothing was spent: the void is an exact reversal (balance back to 50) and nothing needs reusing.
		_, cust, p, id := redeemScenario(t, 100)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 100, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 100 0}", got)
		}
		if got := pointsOf(cust); got != 100 {
			t.Fatalf("balance = %d, want 100 (as before the void)", got)
		}
	})

	t.Run("replacement_points_partly_removed", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 20))
		if err != nil {
			t.Fatal(err)
		}
		// 20 points = Rp2.000 off: the cart ends at 98000, the original total 95000 forces -3000.
		if got := booked(res.ReplacementOrderID); got != (replBooked{20, 50, -3000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {20 50 -3000}", got)
		}
		if got := pointsOf(cust); got != 30 {
			t.Fatalf("balance = %d, want 30", got)
		}
	})

	t.Run("replacement_points_removed_entirely", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 0))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{0, 50, -5000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {0 50 -5000}", got)
		}
		if got := pointsOf(cust); got != 50 {
			t.Fatalf("balance = %d, want 50 (the restored points stay with the customer)", got)
		}
	})

	t.Run("replacement_points_validated_after_restore", func(t *testing.T) {
		// Asking for 80 when the sale redeemed 50: the cap is the balance after the restore plus the
		// reusable 50, never more than the customer can cover (balance 0 + min(50, earn 50)). The
		// replacement uses what is available instead of refusing; the audit is recorded.
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 80))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0} (80 asked, 50 used)", got)
		}
		if got := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID); !strings.Contains(got, "diminta 80, dipakai 50") {
			t.Fatalf("warning reason = %q, want the requested and used points", got)
		}
		if got := ledgerOf(cust); !strings.Contains(got, "redeem:-50>0") {
			t.Fatalf("ledger = %s", got)
		}
		if got := str(`SELECT reason FROM point_transactions WHERE order_id=$1 AND type='redeem'`, res.ReplacementOrderID); !strings.Contains(got, "(diminta 80, dipakai 50)") {
			t.Fatalf("redeem reason = %q", got)
		}
	})

	t.Run("replacement_points_other_customer_nothing_reused", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		other := customer(0)
		// The other customer has no points of their own and nothing is reused for them: the locked
		// replacement redeems 0 (it does not refuse) and the points value lands in the correction.
		res0, err0 := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, other, 50))
		if err0 != nil {
			t.Fatal(err0)
		}
		if got := booked(res0.ReplacementOrderID); got != (replBooked{0, 100, -5000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {0 100 -5000}", got)
		}
		if got := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res0.ReplacementOrderID); !strings.Contains(got, "diminta 50, dipakai 0") {
			t.Fatalf("warning reason = %q, want requested 50 used 0", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("original customer balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_zero_requested_by_choice", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		other := customer(0)
		_ = cust
		// Asking for no points at all is fine: the points value lands in the correction by choice.
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, other, 0))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{0, 100, -5000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {0 100 -5000}", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("original customer balance = %d, want 0", got)
		}
		if got := pointsOf(other); got != 100 {
			t.Fatalf("other customer balance = %d, want 100", got)
		}
	})

	t.Run("replacement_points_other_customer_own_balance", func(t *testing.T) {
		_, _, p, id := redeemScenario(t, 0)
		other := customer(50)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, other, 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 100, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 100 0}", got)
		}
		if got := pointsOf(other); got != 100 {
			t.Fatalf("other customer balance = %d, want 100", got)
		}
	})

	t.Run("replacement_points_no_customer", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, "", 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{0, 0, -5000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {0 0 -5000}", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_sync_item", func(t *testing.T) {
		shift, cust, p, id := redeemScenario(t, 0)
		res := sendItem(cashierTok, replaceItem(shift, id, replPayload(cashLines,
			map[string]any{"customerId": cust, "pointsRedeemed": 50, "correctionTarget": "original_total"}, p)))
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || repl == "" {
			t.Fatalf("result = %v", res)
		}
		if got := booked(repl); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_sync_item_editable_open_shift", func(t *testing.T) {
		// The tablet's own-shift "Batalkan & perbaiki" in an open shift sends no correctionTarget: the
		// same cart with the same points paid with what the original took must book total 95000,
		// correction 0 and no tender warning.
		shift, cust, p, id := redeemScenario(t, 0)
		res := sendItem(cashierTok, replaceItem(shift, id, replPayload(cashLines,
			map[string]any{"customerId": cust, "pointsRedeemed": 50}, p)))
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || repl == "" {
			t.Fatalf("result = %v", res)
		}
		if got := booked(repl); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, repl); got != 95000 {
			t.Fatalf("replacement total = %d, want 95000", got)
		}
		if str(`SELECT tender_warning::text FROM orders WHERE id=$1`, repl) != "false" {
			t.Fatal("replacement carries a tender warning")
		}
	})

	t.Run("replacement_points_over_reuse_not_funded_by_own_earn", func(t *testing.T) {
		// Balance untouched (50 after the void), reuse 50, earn 100: asking for 100 must not be funded
		// from the same sale's earn (a normal sale forbids it). Clamped to 50, editable and locked.
		shift, cust, p, id := redeemScenario(t, 100)
		res := sendItem(cashierTok, replaceItem(shift, id, replPayload(cashLines,
			map[string]any{"customerId": cust, "pointsRedeemed": 100}, p)))
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || repl == "" {
			t.Fatalf("result = %v", res)
		}
		if got := booked(repl); got.redeemed != 50 {
			t.Fatalf("replacement redeemed = %d, want 50 (clamped)", got.redeemed)
		}
		if got := pointsOf(cust); got != 100 {
			t.Fatalf("balance = %d, want 100", got)
		}
		_, cust2, p2, id2 := redeemScenario(t, 100)
		res2, err := svc.VoidAndReplace(ctx, boReplace(id2), replRedeem(p2, cust2, 100))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res2.ReplacementOrderID); got != (replBooked{50, 100, 0}) {
			t.Fatalf("locked replacement redeemed/earned/correction = %+v, want {50 100 0} (clamped, no refusal)", got)
		}
	})

	t.Run("replacement_points_cheaper_cart_clamps", func(t *testing.T) {
		// A re-priced 60000 cart earns 60, 50 of it written off: only 10 points are available to reuse.
		// Locked: 10 are redeemed, the sale still ends at the original 95000 and the gap is the correction.
		_, cust, p, id := redeemScenario(t, 0)
		r := replRedeem(p, cust, 50)
		r.Items[0].Price, r.Items[0].Subtotal = 60000, 60000
		res, err := svc.VoidAndReplace(ctx, boReplace(id), r)
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{10, 10, 36000}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {10 10 36000}", got)
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, res.ReplacementOrderID); got != 95000 {
			t.Fatalf("replacement total = %d, want the original 95000", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_exact_available_no_shortfall_note", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		if got := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID); strings.Contains(got, "points_shortfall") {
			t.Fatalf("warning reason = %q, want no shortfall note", got)
		}
	})

	t.Run("replacement_points_buat_pengganti", func(t *testing.T) {
		_, cust, p, id := redeemScenario(t, 0)
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance after the void = %d, want 0", got)
		}
		if got := one(`SELECT points_restored FROM order_voids WHERE order_id=$1`, id); got != 50 {
			t.Fatalf("void points_restored = %d, want 50 (the column the reuse reads)", got)
		}
		r := replRedeem(p, cust, 50)
		r.ReplacesOrderID = id
		got, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil {
			t.Fatal(err)
		}
		if b := booked(got.OrderID); b != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", b)
		}
		if b := pointsOf(cust); b != 0 {
			t.Fatalf("balance = %d, want 0", b)
		}
	})

	t.Run("replacement_points_buat_pengganti_nothing_available", func(t *testing.T) {
		// The replacement earns nothing (900 cart, earn 0 after the write-off) and the customer has no
		// points: 0 are redeemed, the replacement is still created, and the points value is the correction.
		_, cust, p, id := redeemScenario(t, 0)
		in := bo(id)
		in.Mode = service.VoidModeLater
		if _, err := svc.VoidOrder(ctx, in); err != nil {
			t.Fatal(err)
		}
		r := replRedeem(p, cust, 50)
		r.Items[0].Price, r.Items[0].Subtotal = 900, 900
		r.ReplacesOrderID = id
		got, err := svc.CreateReplacementOrder(ctx, r, true, "")
		if err != nil {
			t.Fatal(err)
		}
		if b := booked(got.OrderID); b != (replBooked{0, 0, 94100}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {0 0 94100}", b)
		}
		if reason := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, got.OrderID); !strings.Contains(reason, "diminta 50, dipakai 0") {
			t.Fatalf("warning reason = %q", reason)
		}
	})

	t.Run("replacement_points_backoffice_direct", func(t *testing.T) {
		_, cust, _, id := redeemScenario(t, 0)
		in := bo(id)
		in.Mode, in.ClientVoidUUID = service.VoidModeReplace, newID("4")
		res, err := svc.VoidAndReplaceDirect(ctx, in, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		if got := pointsOf(cust); got != 0 {
			t.Fatalf("balance = %d, want 0", got)
		}
	})

	t.Run("replacement_points_closed_shift", func(t *testing.T) {
		shift, cust, p, id := redeemScenario(t, 0)
		closeShift(shift)
		res, err := svc.VoidAndReplace(ctx, boReplace(id), replRedeem(p, cust, 50))
		if err != nil {
			t.Fatal(err)
		}
		if got := booked(res.ReplacementOrderID); got != (replBooked{50, 50, 0}) {
			t.Fatalf("replacement redeemed/earned/correction = %+v, want {50 50 0}", got)
		}
		// The correction rows are the cash actually taken, never the points value.
		if got := corrections(shift); !strings.Contains(got, ":cash:95000") {
			t.Fatalf("shift corrections = %q, want the 95000 cash on both sides", got)
		}
	})

	t.Run("sync_replacement_device_defaults_to_envelope", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		const dev = "00000000-0000-4000-9100-0000000000d1"
		item := replaceItem(shift, id, replPayload(`[{"method":"cash","amount":100000}]`, nil, p))
		item["idempotencyKey"] = dev + ":" + item["payload"].(map[string]any)["orderUuid"].(string)
		item["envelope"].(map[string]any)["deviceId"] = dev
		delete(item["payload"].(map[string]any), "deviceId") // the tablet did not stamp it
		res := sendItem(cashierTok, item)
		repl, _ := res["replacementOrderId"].(string)
		if res["status"] != "ok" || repl == "" {
			t.Fatalf("result = %v", res)
		}
		if got := str(`SELECT COALESCE(device_id::text,'') FROM orders WHERE id=$1`, repl); got != dev {
			t.Fatalf("replacement device_id = %q, want the envelope device", got)
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
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{"reasonCode": "transaksi_tes", "mode": "bogus", "clientVoidUuid": newID("4")}); code != http.StatusBadRequest {
			t.Fatalf("unknown mode = %d, want 400", code)
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

	// ── Phase 2, Task 2.5: Backoffice replacement, no-replacement mark, shift read ─────────
	t.Run("direct_void_replace_payment_fix", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := sale(saleOpts{shift: shift, tenders: `[{"method":"cash","amount":200000},{"method":"card","amount":100000}]`}, ps...)
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		body := map[string]any{
			"reasonCode": "salah_metode_pembayaran", "mode": "replace", "clientVoidUuid": newID("4"),
			"replacement": map[string]any{"tenders": []any{map[string]any{"method": "qris", "amount": 300000}}},
		}
		code, out := do(anyTok, http.MethodPost, "/orders/"+id+"/void", body)
		if code != http.StatusOK {
			t.Fatalf("void+replace = %d %v", code, out)
		}
		data := out["data"].(map[string]any)
		repl := data["void"].(map[string]any)["replacementOrderId"].(string)
		if status(id) != "cancelled" || status(repl) != "completed" {
			t.Fatalf("statuses %s / %s", status(id), status(repl))
		}
		if got := one(`SELECT total::int FROM orders WHERE id=$1`, repl); got != 300000 {
			t.Fatalf("replacement total = %d", got)
		}
		if got := str(`SELECT string_agg(method||':'||amount::int::text, ',') FROM order_tenders WHERE order_id=$1`, repl); got != "qris:300000" {
			t.Fatalf("replacement tenders = %s", got)
		}
		if code, out := do(anyTok, http.MethodGet, "/orders/"+repl, nil); code != http.StatusOK || out["data"].(map[string]any)["correctionAmount"].(float64) != 0 {
			t.Fatalf("read of the replacement = %d %v", code, out)
		}
		// A retry with the same client uuid replays: one replacement.
		if code, _ := do(anyTok, http.MethodPost, "/orders/"+id+"/void", body); code != http.StatusOK ||
			one(`SELECT count(*) FROM orders WHERE replaces_order_id=$1`, id) != 1 {
			t.Fatal("retry did not replay")
		}
	})

	t.Run("direct_void_replace_amount_mismatch", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		id := sale(saleOpts{shift: shift}, p)
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		code, out := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{
			"reasonCode": "salah_metode_pembayaran", "mode": "replace", "clientVoidUuid": newID("4"),
			"replacement": map[string]any{"tenders": []any{map[string]any{"method": "cash", "amount": 120000}}},
		})
		if code != http.StatusBadRequest || !strings.Contains(fmt.Sprint(out), "Rp 100.000") {
			t.Fatalf("mismatch = %d %v, want 400 naming Rp 100.000", code, out)
		}
		if status(id) != "completed" {
			t.Fatal("refused replacement voided the sale")
		}
	})

	t.Run("shift_read_corrected", func(t *testing.T) {
		shift := openShift()
		ps := []string{product(5), product(5), product(5)}
		id := splitSale(shift, ps...)
		closeShift(shift)
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		before := snapshot(shift)
		if code, out := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{
			"reasonCode": "salah_metode_pembayaran", "mode": "replace", "clientVoidUuid": newID("4"),
			"replacement": map[string]any{"tenders": []any{map[string]any{"method": "qris", "amount": 300000}}},
		}); code != http.StatusOK {
			t.Fatalf("void+replace = %d %v", code, out)
		}
		code, out := do(anyTok, http.MethodGet, "/shifts", nil)
		if code != http.StatusOK {
			t.Fatalf("shifts = %d", code)
		}
		var got map[string]any
		for _, s := range out["data"].([]any) {
			if s.(map[string]any)["id"] == shift {
				got = s.(map[string]any)
			}
		}
		if got == nil {
			t.Fatal("shift not listed")
		}
		corr := got["corrections"].(map[string]any)
		if corr["count"].(float64) != 1 || len(corr["items"].([]any)) != 3 {
			t.Fatalf("corrections = %v", corr)
		}
		if got["correctedCashSales"].(float64) != 0 || got["correctedQrisSales"].(float64) != 300000 ||
			got["correctedTotalSales"].(float64) != 300000 || got["correctedTotalOrders"].(float64) != 1 {
			t.Fatalf("corrected figures = %v", got)
		}
		if got["cashSales"].(float64) != 100000 || got["qrisSales"].(float64) != 200000 {
			t.Fatalf("the close snapshot figures moved: %v", got)
		}
		if snapshot(shift) != before {
			t.Fatal("snapshot columns changed")
		}
	})

	t.Run("mark_no_replacement_endpoint", func(t *testing.T) {
		shift := openShift()
		id := sale(saleOpts{shift: shift}, product(5))
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		path := "/orders/" + id + "/void/no-replacement"
		if code, _ := do(anyTok, http.MethodPost, path, nil); code != http.StatusConflict {
			t.Fatalf("mark on a sale that is not voided = %d, want 409", code)
		}
		if code, out := do(anyTok, http.MethodPost, "/orders/"+id+"/void", map[string]any{
			"reasonCode": "transaksi_ganda", "mode": "later", "clientVoidUuid": newID("4")}); code != http.StatusOK {
			t.Fatalf("void later = %d %v", code, out)
		}
		if code, _ := do(cashierTok, http.MethodPost, path, nil); code != http.StatusForbidden {
			t.Fatalf("mark without void_any = %d, want 403", code)
		}
		code, out := do(anyTok, http.MethodPost, path, map[string]any{"note": "pelanggan batal"})
		if code != http.StatusOK || out["data"].(map[string]any)["void"].(map[string]any)["followup"] != "no_replacement" {
			t.Fatalf("mark = %d %v", code, out)
		}
		if code, _ := do(anyTok, http.MethodPost, path, nil); code != http.StatusConflict {
			t.Fatalf("second mark = %d, want 409", code)
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

	// ── Phase 4, Task 4.1: the Pembatalan report ─────────────────────────────────────────────
	reportTok := tok(manager, "manager", []string{"view_reports"})
	reportRows := func(q string) (map[string]any, map[string]map[string]any) {
		t.Helper()
		code, out := do(reportTok, http.MethodGet, "/void-report?"+q, nil)
		if code != http.StatusOK {
			t.Fatalf("void-report?%s = %d %v", q, code, out)
		}
		byOrder := map[string]map[string]any{}
		for _, r := range out["data"].([]any) {
			row := r.(map[string]any)
			byOrder[row["orderId"].(string)] = row
		}
		return out, byOrder
	}
	voidAs := func(voider, orderID, shift string, reason service.VoidReasonCode, mode service.VoidMode) service.VoidResult {
		t.Helper()
		in := voidIn(orderID, shift)
		in.UserID, in.UserName, in.Reason, in.Mode = voider, "VD Voider", reason, mode
		res, err := svc.VoidOrder(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	t.Run("void_report_by_reason", func(t *testing.T) {
		shift := openShift()
		voider := newID("6")
		a := sale(saleOpts{shift: shift}, product(5))
		b := sale(saleOpts{shift: shift}, product(5), product(5))
		c := sale(saleOpts{shift: shift}, product(5))
		voidAs(voider, a, shift, service.VoidReasonWrongPayment, service.VoidModeNone)
		voidAs(voider, b, shift, service.VoidReasonWrongPayment, service.VoidModeNone)
		voidAs(voider, c, shift, service.VoidReasonDuplicate, service.VoidModeNone)
		out, _ := reportRows("cashierId=" + voider + "&limit=1")
		if len(out["data"].([]any)) != 1 || out["meta"].(map[string]any)["total"].(float64) != 3 {
			t.Fatalf("page/meta = %v", out["meta"])
		}
		by := map[string]map[string]any{}
		for _, r := range out["byReason"].([]any) {
			by[r.(map[string]any)["reasonCode"].(string)] = r.(map[string]any)
		}
		if len(by) != 2 || by["salah_metode_pembayaran"]["voids"].(float64) != 2 || by["salah_metode_pembayaran"]["originalTotal"].(float64) != 300000 ||
			by["transaksi_ganda"]["voids"].(float64) != 1 || by["transaksi_ganda"]["originalTotal"].(float64) != 100000 {
			t.Fatalf("byReason = %v", out["byReason"])
		}
		tot := out["totals"].(map[string]any)
		if tot["voids"].(float64) != 3 || tot["originalTotal"].(float64) != 400000 {
			t.Fatalf("totals over the whole range, not the page = %v", tot)
		}
		// CashierID is the voider: the seller's id finds none of these.
		_, sellerRows := reportRows("cashierId=" + cashier + "&limit=200")
		for _, id := range []string{a, b, c} {
			if _, ok := sellerRows[id]; ok {
				t.Fatalf("order %s listed for the seller id; cashierId must match the voider", id)
			}
		}
		_, byReasonFilter := reportRows("cashierId=" + voider + "&reasonCode=transaksi_ganda")
		if len(byReasonFilter) != 1 || byReasonFilter[c] == nil {
			t.Fatalf("reasonCode filter = %v", byReasonFilter)
		}
		if code, _ := do(reportTok, http.MethodGet, "/void-report?reasonCode=bogus", nil); code != http.StatusBadRequest {
			t.Fatalf("bad reasonCode = %d, want 400", code)
		}
		if code, _ := do(reportTok, http.MethodGet, "/void-report?cashierId=not-a-uuid", nil); code != http.StatusBadRequest {
			t.Fatalf("bad cashierId = %d, want 400", code)
		}
		if code, _ := do(reportTok, http.MethodGet, "/void-report?dateFrom=nope", nil); code != http.StatusBadRequest {
			t.Fatalf("bad date = %d, want 400", code)
		}
	})

	t.Run("void_report_rows", func(t *testing.T) {
		shift := openShift()
		voider := newID("6")
		ps := []string{product(5), product(5), product(5)}
		replaced := sale(saleOpts{shift: shift, tenders: `[{"method":"cash","amount":200000},{"method":"card","amount":100000}]`}, ps...)
		later := sale(saleOpts{shift: shift}, product(5))
		none := sale(saleOpts{shift: shift}, product(5))
		marked := sale(saleOpts{shift: shift}, product(5))
		in := bo(replaced)
		in.UserID, in.UserName, in.Mode, in.ClientVoidUUID = voider, "VD Voider", service.VoidModeReplace, newID("4")
		res, err := svc.VoidAndReplaceDirect(ctx, in, service.ReplacementOverride{Tenders: json.RawMessage(`[{"method":"qris","amount":300000}]`)})
		if err != nil {
			t.Fatal(err)
		}
		voidAs(voider, later, shift, service.VoidReasonWrongItems, service.VoidModeLater)
		voidAs(voider, none, shift, service.VoidReasonTest, service.VoidModeNone)
		voidAs(voider, marked, shift, service.VoidReasonWrongItems, service.VoidModeLater)
		if err := svc.MarkVoidNoReplacement(ctx, outlet, marked, adminU, "VD Admin", ""); err != nil {
			t.Fatal(err)
		}
		out, rows := reportRows("cashierId=" + voider + "&limit=200")
		for id, want := range map[string]string{replaced: "replaced", later: "awaiting_replacement", none: "no_replacement", marked: "no_replacement"} {
			if rows[id] == nil || rows[id]["state"] != want || rows[id]["kind"] != "void" {
				t.Fatalf("order %s row = %v, want state %s", id, rows[id], want)
			}
		}
		r := rows[replaced]
		if r["replacementOrderId"] != res.ReplacementOrderID || r["replacementTotal"].(float64) != 300000 || r["correctionAmount"].(float64) != 0 ||
			r["originalTotal"].(float64) != 300000 || r["voidedByName"] != "VD Voider" || r["afterClose"] != false {
			t.Fatalf("replaced row = %v", r)
		}
		if ot := r["originalTenders"].([]any); len(ot) != 2 || ot[0].(map[string]any)["method"] != "cash" {
			t.Fatalf("originalTenders = %v", r["originalTenders"])
		}
		if rt := r["replacementTenders"].([]any); len(rt) != 1 || rt[0].(map[string]any)["method"] != "qris" {
			t.Fatalf("replacementTenders = %v", r["replacementTenders"])
		}
		if rows[later]["replacementOrderId"] != nil {
			t.Fatal("an awaiting row carries a replacement")
		}
		tot := out["totals"].(map[string]any)
		if tot["voids"].(float64) != 4 || tot["originalTotal"].(float64) != 600000 || tot["replacementTotal"].(float64) != 300000 || tot["correctionTotal"].(float64) != 0 {
			t.Fatalf("totals = %v", tot)
		}
		// A replacement that is later voided still counts in replacementTotal (= the rows' sum); it is its own void row.
		in2 := bo(res.ReplacementOrderID)
		in2.UserID, in2.UserName, in2.ClientVoidUUID = voider, "VD Voider", newID("4")
		if _, err := svc.VoidOrder(ctx, in2); err != nil {
			t.Fatal(err)
		}
		out, _ = reportRows("cashierId=" + voider + "&limit=200")
		tot = out["totals"].(map[string]any)
		if tot["voids"].(float64) != 5 || tot["replacementTotal"].(float64) != 300000 || tot["correctionTotal"].(float64) != 0 {
			t.Fatalf("totals after voiding the replacement = %v, want replacementTotal to still equal the rows' sum (300000)", tot)
		}
		// afterClose filter: everything above was voided while the shift was open.
		if _, closed := reportRows("cashierId=" + voider + "&afterClose=true"); len(closed) != 0 {
			t.Fatalf("afterClose=true listed %d rows", len(closed))
		}
		if _, open := reportRows("cashierId=" + voider + "&afterClose=false&limit=200"); len(open) != 5 {
			t.Fatalf("afterClose=false listed %d rows, want 5", len(open))
		}
	})

	t.Run("void_report_lists_legacy_import", func(t *testing.T) {
		const day = "2020-01-02"
		legacy := newID("7")
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,amount_paid,status,business_date)
		      VALUES($1,'VD-LEGACY',gen_random_uuid(),$2,$3,$4,'VD Kasir',50000,50000,'cash',50000,'cancelled',$5::date)`, legacy, "vd-legacy-"+legacy, outlet, cashier, day)
		out, rows := reportRows("dateFrom=" + day + "&dateTo=" + day)
		row := rows[legacy]
		if row == nil || row["kind"] != "legacy_import" || row["state"] != "legacy" || row["originalTotal"].(float64) != 50000 {
			t.Fatalf("legacy row = %v", row)
		}
		if tot := out["totals"].(map[string]any); tot["voids"].(float64) != 0 || tot["originalTotal"].(float64) != 0 {
			t.Fatalf("legacy row counted in totals: %v", tot)
		}
		if out["meta"].(map[string]any)["total"].(float64) != 1 || len(out["byReason"].([]any)) != 0 {
			t.Fatalf("meta/byReason = %v / %v", out["meta"], out["byReason"])
		}
		// Void-specific filters leave it out.
		if _, withReason := reportRows("dateFrom=" + day + "&dateTo=" + day + "&reasonCode=lainnya"); len(withReason) != 0 {
			t.Fatal("legacy row listed under a reason filter")
		}
	})

	t.Run("void_report_forbidden", func(t *testing.T) {
		if code, _ := do(cashierTok, http.MethodGet, "/void-report", nil); code != http.StatusForbidden {
			t.Fatalf("without view_reports = %d, want 403", code)
		}
		// A non-admin whose token names no outlet fails closed, never "all outlets".
		bare, err := auth.IssueAccess(key, time.Hour, manager, "manager", "", []string{"view_reports"})
		if err != nil {
			t.Fatal(err)
		}
		if code, _ := do(bare, http.MethodGet, "/void-report", nil); code != http.StatusForbidden {
			t.Fatalf("no outlet = %d, want 403", code)
		}
	})

	// ── Phase 4, Part B: a Backoffice replacement keeps the original's promotions ──────────────
	ln := func(pid string, qty int, price float64) service.OrderItem {
		return service.OrderItem{ProductID: pid, ProductName: "VD", VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
	}
	// promoOrder sells online, like the POS does, with whatever promotion fields mod sets.
	promoOrder := func(shift string, items []service.OrderItem, mod func(*service.CreateOrderInput)) string {
		t.Helper()
		in := service.CreateOrderInput{
			IdempotencyKey: "vd-promo-" + newID("4"), OrderUUID: newID("4"), OutletID: outlet,
			CashierID: cashier, CashierName: "VD Kasir", Items: items, PaymentMethod: "cash", AmountPaid: 1_000_000, ShiftID: shift,
		}
		mod(&in)
		id, dup, _, err := svc.CreateOrder(ctx, in)
		if err != nil || dup {
			t.Fatalf("promo sale: dup=%v err=%v", dup, err)
		}
		// Pay exactly the total (no change), so the stored tender is what the store received.
		exec(`UPDATE orders SET amount_paid=total, change=0 WHERE id=$1`, id)
		exec(`UPDATE order_tenders SET amount=(SELECT total FROM orders WHERE id=$1) WHERE order_id=$1`, id)
		return id
	}
	booked3 := func(id string) string {
		return str(`SELECT total::bigint||'/'||discount_amount::bigint||'/'||correction_amount::bigint FROM orders WHERE id=$1`, id)
	}
	// payFix is a Backoffice "Salah metode pembayaran": same sale, paid by QRIS.
	payFix := func(orig string, ov service.ReplacementOverride) (service.VoidResult, error) {
		in := bo(orig)
		in.Mode, in.ClientVoidUUID = service.VoidModeReplace, newID("4")
		if ov.Tenders == nil {
			ov.Tenders = json.RawMessage(fmt.Sprintf(`[{"method":"qris","amount":%d}]`, one(`SELECT total::int FROM orders WHERE id=$1`, orig)))
		}
		return svc.VoidAndReplaceDirect(ctx, in, ov)
	}
	pctPromo := func(name string, value int) string {
		id := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable) VALUES($1,$2,'percentage',$3,true)`, id, name, value)
		return id
	}
	threeLines := func() ([]service.OrderItem, []string) {
		ps := []string{product(5), product(5), product(5)}
		return []service.OrderItem{ln(ps[0], 1, 100000), ln(ps[1], 1, 100000), ln(ps[2], 1, 100000)}, ps
	}

	t.Run("replacement_promo_percentage_zero_correction", func(t *testing.T) {
		shift := openShift()
		promo := pctPromo("VD PCT 10", 10)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD PCT 10"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT 10","kind":"percentage","value":10,"amount":30000}]`)
		})
		if got := booked3(orig); got != "270000/30000/0" {
			t.Fatalf("fixture: original total/discount/correction = %s", got)
		}
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked3(res.ReplacementOrderID); got != "270000/30000/0" {
			t.Fatalf("replacement total/discount/correction = %s, want 270000/30000/0 (the promotion is re-applied, no correction)", got)
		}
		if str(`SELECT string_agg(method||':'||amount::int::text, ',') FROM order_tenders WHERE order_id=$1`, res.ReplacementOrderID) != "qris:270000" {
			t.Fatal("replacement tenders")
		}
		if one(`SELECT count(*) FROM shift_corrections WHERE order_id IN ($1,$2)`, orig, res.ReplacementOrderID) != 0 {
			t.Fatal("an open shift got correction rows")
		}
	})

	t.Run("replacement_promo_bxgy_free_item_zero_correction", func(t *testing.T) {
		shift := openShift()
		buy, get := product(5), product(5)
		promo := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,bxgy_config) VALUES($1,'VD BXGY','buy_x_get_y',0,true,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":100}`, buy, get))
		reward := ln(get, 1, 0)
		reward.IsReward, reward.RewardPromotionID = true, promo
		orig := promoOrder(shift, []service.OrderItem{ln(buy, 1, 100000), reward}, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD BXGY"
			in.DiscountBreakdown = []byte(`[{"label":"VD BXGY","kind":"buy_x_get_y","value":0,"amount":100000}]`)
		})
		if got := booked3(orig); !strings.HasPrefix(got, "100000/") || one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, orig) != 1 {
			t.Fatalf("fixture: %s / grants %d", got, one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, orig))
		}
		getStock := stockOf(get)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		repl := res.ReplacementOrderID
		if got := booked3(repl); got != booked3(orig) || !strings.HasSuffix(got, "/0") {
			t.Fatalf("replacement = %s, original = %s; want the same with zero correction", got, booked3(orig))
		}
		if one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1 AND promotion_id=$2`, repl, promo) != 1 {
			t.Fatal("the replacement did not write its reward grant")
		}
		if str(`SELECT string_agg(refund_group, ',' ORDER BY line_no) FROM order_items WHERE order_id=$1`, repl) !=
			str(`SELECT string_agg(refund_group, ',' ORDER BY line_no) FROM order_items WHERE order_id=$1`, orig) {
			t.Fatal("the replacement's refund groups differ from the original's")
		}
		if stockOf(get) != getStock {
			t.Fatalf("free item stock %d -> %d, want unchanged by void+replace", getStock, stockOf(get))
		}
	})

	t.Run("replacement_promo_tiered_code_and_manual_zero_correction", func(t *testing.T) {
		shift := openShift()
		tier := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,tiered_config) VALUES($1,'VD TIER','tiered',0,true,$2::jsonb)`, tier,
			`{"tiers":[{"minSubtotal":200000,"kind":"percentage","value":10}]}`)
		exec(`INSERT INTO discount_codes(code,type,value,combinable) VALUES('VDTIERCODE','fixed',5000,true)`)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountCodes, in.DiscountCode = []string{tier}, []string{"VDTIERCODE"}, "VDTIERCODE"
			in.ManualKind, in.ManualValue = service.DiscountFixed, 2000
			in.DiscountLabel = "VD TIER"
			in.DiscountBreakdown = []byte(`[{"label":"Diskon Manual","kind":"fixed","value":2000,"amount":2000},{"label":"VD TIER","kind":"tiered","value":10,"amount":30000},{"label":"VDTIERCODE","kind":"fixed","value":5000,"amount":5000}]`)
		})
		before := booked3(orig)
		if !strings.HasSuffix(before, "/0") || strings.HasPrefix(before, "300000/") {
			t.Fatalf("fixture: %s", before)
		}
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked3(res.ReplacementOrderID); got != before {
			t.Fatalf("replacement = %s, original = %s (tiered + code + manual must reproduce)", got, before)
		}
		if one(`SELECT usage_count FROM discount_codes WHERE code='VDTIERCODE'`) != 1 {
			t.Fatal("the code is used once: released by the void, taken again by the replacement")
		}
	})

	t.Run("replacement_promo_judged_at_sale_time_not_now", func(t *testing.T) {
		shift := openShift()
		promo := pctPromo("VD PCT PAST", 10)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD PCT PAST"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT PAST","kind":"percentage","value":10,"amount":30000}]`)
		})
		// The sale was three days ago; the promotion ended yesterday.
		exec(`UPDATE orders SET created_at = now() - interval '3 days' WHERE id=$1`, orig)
		exec(`UPDATE promotions SET created_at = now() - interval '10 days' WHERE id=$1`, promo)
		exec(`UPDATE promotions SET start_date = current_date - 10, end_date = current_date - 1 WHERE id=$1`, promo)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked3(res.ReplacementOrderID); got != "270000/30000/0" {
			t.Fatalf("replacement = %s, want 270000/30000/0", got)
		}
		if str(`SELECT discount_warning::text FROM orders WHERE id=$1`, res.ReplacementOrderID) != "false" {
			t.Fatalf("an expired-since promotion was flagged: %s", str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID))
		}
	})

	t.Run("replacement_promo_deactivated_since_lands_in_correction", func(t *testing.T) {
		shift := openShift()
		promo := pctPromo("VD PCT OFF", 10)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD PCT OFF"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT OFF","kind":"percentage","value":10,"amount":30000}]`)
		})
		exec(`UPDATE promotions SET is_active=false WHERE id=$1`, promo)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		// Cannot be reproduced: the sale still ends at the original total, the 30000 is the correction.
		if got := booked3(res.ReplacementOrderID); got != "270000/0/-30000" {
			t.Fatalf("replacement = %s, want 270000/0/-30000 (total kept, promotion value as Penyesuaian koreksi)", got)
		}
		if w := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID); !strings.Contains(w, "promo_not_reproduced") {
			t.Fatalf("an unreproduced promotion must be flagged for review, got %q", w)
		}
	})

	t.Run("replacement_promo_same_name_is_not_guessed", func(t *testing.T) {
		shift := openShift()
		a, b := pctPromo("VD PCT TWIN", 10), pctPromo("VD PCT TWIN", 20)
		_ = b
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{a}, "VD PCT TWIN"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT TWIN","kind":"percentage","value":10,"amount":30000}]`)
		})
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked3(res.ReplacementOrderID); got != "270000/0/-30000" {
			t.Fatalf("replacement = %s, want 270000/0/-30000 (two promotions share the name: none is guessed)", got)
		}
	})

	t.Run("replacement_promo_customer_change_with_assigned_code", func(t *testing.T) {
		shift := openShift()
		custA, custB := customer(0), customer(0)
		exec(`INSERT INTO discount_codes(code,type,value,combinable,customer_id) VALUES('VDCUSTCODE','fixed',5000,true,$1)`, custA)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.CustomerID, in.DiscountCodes, in.DiscountCode, in.DiscountLabel = custA, []string{"VDCUSTCODE"}, "VDCUSTCODE", "VDCUSTCODE"
			in.DiscountBreakdown = []byte(`[{"label":"VDCUSTCODE","kind":"fixed","value":5000,"amount":5000}]`)
		})
		if got := booked3(orig); got != "295000/5000/0" {
			t.Fatalf("fixture: %s", got)
		}
		res, err := payFix(orig, service.ReplacementOverride{CustomerID: &custB})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("customer change on a customer-assigned code: %s, warning %q", booked3(res.ReplacementOrderID),
			str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID))
		if got := booked3(res.ReplacementOrderID); got != "295000/5000/0" {
			t.Fatalf("replacement = %s, want 295000/5000/0", got)
		}
		if w := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, res.ReplacementOrderID); !strings.Contains(w, "wrong_customer") {
			t.Fatalf("the ineligible code must be flagged for review, got %q", w)
		}
	})

	t.Run("replacement_promo_reward_no_longer_entitled_stays_plain", func(t *testing.T) {
		shift := openShift()
		buy, get := product(5), product(5)
		promo := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,bxgy_config) VALUES($1,'VD BXGY GONE','buy_x_get_y',0,true,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":100}`, buy, get))
		reward := ln(get, 1, 0)
		reward.IsReward, reward.RewardPromotionID = true, promo
		orig := promoOrder(shift, []service.OrderItem{ln(buy, 1, 100000), reward}, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD BXGY GONE"
		})
		// The promotion now needs 9 bought units: the free line stays a plain line, flagged for review.
		exec(`UPDATE promotions SET bxgy_config = jsonb_set(bxgy_config, '{buyQuantity}', '9') WHERE id=$1`, promo)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatalf("payment-only fix refused: %v", err)
		}
		repl := res.ReplacementOrderID
		if got := booked3(repl); got != booked3(orig) || !strings.HasSuffix(got, "/0") || one(`SELECT count(*) FROM order_items WHERE order_id=$1`, repl) != 2 {
			t.Fatalf("replacement = %s, original = %s; want the same total, zero correction, both lines kept", got, booked3(orig))
		}
		if one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, repl) != 0 {
			t.Fatal("an unentitled reward still wrote a grant")
		}
		if w := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, repl); !strings.Contains(w, "promo_not_reproduced") {
			t.Fatalf("warning = %q", w)
		}
	})

	t.Run("replacement_bundle_order_refused_for_backoffice", func(t *testing.T) {
		shift := openShift()
		p := product(5)
		orig := sale(saleOpts{shift: shift}, p)
		exec(`UPDATE order_items SET bundle_group=1, bundle_role='large' WHERE order_id=$1`, orig)
		before := stockOf(p)
		if _, err := payFix(orig, service.ReplacementOverride{}); err == nil || !strings.Contains(err.Error(), "bundle") {
			t.Fatalf("err = %v, want the bundle refusal", err)
		}
		if status(orig) != "completed" || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, orig) != 0 || stockOf(p) != before {
			t.Fatal("a refused bundle replacement changed the sale, voided it or moved stock")
		}
	})

	t.Run("replacement_promo_bxgy_campaign_ended_keeps_free_item_with_warning", func(t *testing.T) {
		shift := openShift()
		buy, get := product(5), product(5)
		promo := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,bxgy_config) VALUES($1,'VD BXGY ENDED','buy_x_get_y',0,true,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":100}`, buy, get))
		reward := ln(get, 1, 0)
		reward.IsReward, reward.RewardPromotionID = true, promo
		orig := promoOrder(shift, []service.OrderItem{ln(buy, 1, 100000), reward}, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD BXGY ENDED"
		})
		// Campaign deactivated and the reward product retired after the sale; a payment fix must still work.
		exec(`UPDATE promotions SET is_active=false WHERE id=$1`, promo)
		exec(`UPDATE products SET is_active=false WHERE id=$1`, get)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatalf("payment-only fix refused: %v", err)
		}
		repl := res.ReplacementOrderID
		if got := booked3(repl); got != booked3(orig) || !strings.HasSuffix(got, "/0") {
			t.Fatalf("replacement = %s, original = %s; want the same with zero correction", got, booked3(orig))
		}
		if one(`SELECT count(*) FROM order_items WHERE order_id=$1`, repl) != 2 {
			t.Fatal("the free item was dropped from the replacement")
		}
		if w := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, repl); !strings.Contains(w, "promo_not_reproduced") {
			t.Fatalf("warning = %q, want promo_not_reproduced", w)
		}
	})

	t.Run("replacement_promo_label_match_ignores_promotions_created_after_the_sale", func(t *testing.T) {
		shift := openShift()
		old, late := pctPromo("VD PCT LATE", 10), pctPromo("VD PCT LATE", 20)
		exec(`UPDATE promotions SET created_at = now() + interval '1 hour' WHERE id=$1`, late)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{old}, "VD PCT LATE"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT LATE","kind":"percentage","value":10,"amount":30000}]`)
		})
		exec(`UPDATE promotions SET is_active=false WHERE id=$1`, old)
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		if got := booked3(res.ReplacementOrderID); got != "270000/0/-30000" {
			t.Fatalf("replacement = %s, want 270000/0/-30000 (the later same-name promotion must not be applied)", got)
		}
	})

	t.Run("direct_void_retry_replays_before_any_recovery", func(t *testing.T) {
		shift := openShift()
		anyTok := tok(adminU, "cashier", []string{"void_any"})
		buy, get := product(5), product(5)
		promo := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,bxgy_config) VALUES($1,'VD BXGY RETRY','buy_x_get_y',0,true,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":100}`, buy, get))
		reward := ln(get, 1, 0)
		reward.IsReward, reward.RewardPromotionID = true, promo
		orig := promoOrder(shift, []service.OrderItem{ln(buy, 1, 100000), reward}, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{promo}, "VD BXGY RETRY"
		})
		body := map[string]any{
			"reasonCode": "salah_metode_pembayaran", "mode": "replace", "clientVoidUuid": newID("4"),
			"replacement": map[string]any{"tenders": []any{map[string]any{"method": "qris", "amount": 100000}}},
		}
		ids := func(out map[string]any) string {
			v := out["data"].(map[string]any)["void"].(map[string]any)
			return fmt.Sprint(v["id"], "/", v["replacementOrderId"])
		}
		code, first := do(anyTok, http.MethodPost, "/orders/"+orig+"/void", body)
		if code != http.StatusOK {
			t.Fatalf("void+replace = %d %v", code, first)
		}
		// Between the original response and the retry the campaign is switched off: a replay must not
		// re-evaluate anything.
		exec(`UPDATE promotions SET is_active=false WHERE id=$1`, promo)
		code, again := do(anyTok, http.MethodPost, "/orders/"+orig+"/void", body)
		if code != http.StatusOK || ids(again) != ids(first) {
			t.Fatalf("replace retry = %d %v, want the same void and replacement ids as %s", code, ids(again), ids(first))
		}
		if one(`SELECT count(*) FROM orders WHERE replaces_order_id=$1`, orig) != 1 || one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, orig) != 1 {
			t.Fatal("the retry created a second void or replacement")
		}
		// mode later and none replay too.
		for _, mode := range []string{"later", "none"} {
			id := sale(saleOpts{shift: shift}, product(5))
			b := map[string]any{"reasonCode": "transaksi_tes", "mode": mode, "clientVoidUuid": newID("4")}
			c1, o1 := do(anyTok, http.MethodPost, "/orders/"+id+"/void", b)
			c2, o2 := do(anyTok, http.MethodPost, "/orders/"+id+"/void", b)
			if c1 != http.StatusOK || c2 != http.StatusOK || o1["data"].(map[string]any)["void"].(map[string]any)["id"] != o2["data"].(map[string]any)["void"].(map[string]any)["id"] {
				t.Fatalf("mode %s retry = %d/%d", mode, c1, c2)
			}
			if one(`SELECT count(*) FROM order_voids WHERE order_id=$1`, id) != 1 {
				t.Fatalf("mode %s retry voided twice", mode)
			}
		}
	})

	t.Run("replacement_promo_code_linked_to_bxgy_keeps_the_code", func(t *testing.T) {
		shift := openShift()
		buy, get := product(5), product(5)
		promo := newID("8")
		exec(`INSERT INTO promotions(id,name,type,value,combinable,code_only,bxgy_config) VALUES($1,'VD BXGY LINKED','buy_x_get_y',0,true,true,$2::jsonb)`, promo,
			fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":100}`, buy, get))
		exec(`INSERT INTO discount_codes(code,promotion_id,type,value,combinable) VALUES('VDLINKBX',$1,'fixed',1,true)`, promo)
		reward := ln(get, 1, 0)
		reward.IsReward, reward.RewardPromotionID = true, promo
		orig := promoOrder(shift, []service.OrderItem{ln(buy, 1, 100000), reward}, func(in *service.CreateOrderInput) {
			in.DiscountCodes, in.DiscountCode, in.DiscountLabel = []string{"VDLINKBX"}, "VDLINKBX", "VDLINKBX"
		})
		if one(`SELECT usage_count FROM discount_codes WHERE code='VDLINKBX'`) != 1 || one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, orig) != 1 {
			t.Fatal("fixture: the linked code sale did not use the code and grant the reward")
		}
		res, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		repl := res.ReplacementOrderID
		if got := booked3(repl); got != booked3(orig) || !strings.HasSuffix(got, "/0") {
			t.Fatalf("replacement = %s, original = %s; want the same with zero correction", got, booked3(orig))
		}
		if got := str(`SELECT COALESCE(applied_discount_codes::text,'null') FROM orders WHERE id=$1`, repl); got != `["VDLINKBX"]` {
			t.Fatalf("applied_discount_codes = %s, want the code kept", got)
		}
		if one(`SELECT usage_count FROM discount_codes WHERE code='VDLINKBX'`) != 1 {
			t.Fatal("usage_count did not come back to the original value")
		}
		if one(`SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, repl) != 1 {
			t.Fatal("the replacement lost the reward grant")
		}
		if w := str(`SELECT COALESCE(discount_warning_reason,'') FROM orders WHERE id=$1`, repl); w != "" {
			t.Fatalf("unexpected warning %q (a code_only promotion applied through its code is normal)", w)
		}
	})

	t.Run("replacement_promo_chain_is_judged_at_the_first_sale_time", func(t *testing.T) {
		shift := openShift()
		first, later := pctPromo("VD PCT CHAIN", 10), pctPromo("VD PCT CHAIN", 20)
		items, _ := threeLines()
		orig := promoOrder(shift, items, func(in *service.CreateOrderInput) {
			in.PromotionIDs, in.DiscountLabel = []string{first}, "VD PCT CHAIN"
			in.DiscountBreakdown = []byte(`[{"label":"VD PCT CHAIN","kind":"percentage","value":10,"amount":30000}]`)
		})
		// Sale three days ago; the look-alike promotion was created yesterday, after the sale.
		exec(`UPDATE orders SET created_at = now() - interval '3 days' WHERE id=$1`, orig)
		exec(`UPDATE promotions SET created_at = now() - interval '10 days' WHERE id=$1`, first)
		exec(`UPDATE promotions SET created_at = now() - interval '1 day' WHERE id=$1`, later)
		r1, err := payFix(orig, service.ReplacementOverride{})
		if err != nil {
			t.Fatal(err)
		}
		r2, err := payFix(r1.ReplacementOrderID, service.ReplacementOverride{Tenders: json.RawMessage(`[{"method":"card","amount":270000}]`)})
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{r1.ReplacementOrderID, r2.ReplacementOrderID} {
			if got := booked3(id); got != "270000/30000/0" {
				t.Fatalf("replacement %s = %s, want 270000/30000/0 (the promotion created after the sale must not be matched)", id, got)
			}
		}
	})

	// ── Void policy 2026-11-24, item 1: the shared outlet shift cannot close while another tablet holds a parked void ──
	router.Post("/sync/review-items", h.ReportSyncReviewItems)
	router.Get("/shifts/current", h.CurrentShift)
	router.Post("/shifts/{id}/close", h.CloseShift)
	t.Run("shift_close_blocked_by_parked_void", func(t *testing.T) {
		const outletZ = "00000000-0000-4000-9100-0000000000f1"
		exec(`INSERT INTO outlets(id,name) VALUES($1,'VD Outlet Z')`, outletZ)
		parked := func(t *testing.T, tokn, reviewKey string, payload map[string]any) {
			t.Helper()
			code, body := do(tokn, http.MethodPost, "/sync/review-items", map[string]any{"items": []any{map[string]any{
				"idempotencyKey": reviewKey, "type": "void", "reviewCode": "forbidden", "reviewReason": "ditolak",
				"clientCreatedAt": time.Now().UTC().Format(time.RFC3339Nano), "payload": payload,
			}}})
			if code != http.StatusOK {
				t.Fatalf("review report = %d %v", code, body)
			}
		}
		closeItem := func(shift string) map[string]any {
			uid := newID("4")
			return map[string]any{
				"type": "shift_close", "idempotencyKey": "vd-devB:" + uid, "payload": map[string]any{"shiftId": shift, "closingCash": 0},
				"envelope": map[string]any{"v": 1, "outletId": outlet, "userId": cashier, "deviceId": "vd-devB", "capturedAt": time.Now().UTC().Format(time.RFC3339), "shiftId": shift},
			}
		}
		wantBlocked := func(t *testing.T, res map[string]any, shift string) {
			t.Helper()
			if res["status"] != "error" || res["code"] != "busy" || res["retryable"] != true {
				t.Fatalf("close result = %v, want a retryable busy refusal", res)
			}
			if str(`SELECT status FROM shifts WHERE id=$1`, shift) != "open" {
				t.Fatal("a refused close changed the shift")
			}
		}
		wantClosed := func(t *testing.T, res map[string]any, shift string) {
			t.Helper()
			if res["status"] != "ok" || str(`SELECT status FROM shifts WHERE id=$1`, shift) != "closed" {
				t.Fatalf("close result = %v, shift %s, want closed", res, str(`SELECT status FROM shifts WHERE id=$1`, shift))
			}
		}
		keyOf := func() string { return "vd-devA:" + newID("4") }
		saleIn := func(shift string) (id, uuid, number string) {
			id = sale(saleOpts{shift: shift}, product(5))
			return id, str(`SELECT order_uuid::text FROM orders WHERE id=$1`, id), str(`SELECT order_number FROM orders WHERE id=$1`, id)
		}

		t.Run("blocked_then_resolved", func(t *testing.T) {
			shift := openShift()
			id, _, number := saleIn(shift)
			reviewKey := keyOf()
			parked(t, cashierTok, reviewKey, map[string]any{"orderId": id, "orderNumber": number, "originalShiftId": shift})
			item := closeItem(shift)
			wantBlocked(t, sendItem(cashierTok, item), shift)
			// The same queued close (same key) lands by itself once head office resolves the item.
			exec(`UPDATE sync_review_items SET resolved_at=now(), resolved_by=$2, resolution_note='ok' WHERE idempotency_key=$1`, reviewKey, adminU)
			wantClosed(t, sendItem(cashierTok, item), shift)
		})
		t.Run("acked_later_does_not_block", func(t *testing.T) {
			shift := openShift()
			id, _, number := saleIn(shift)
			reviewKey := keyOf()
			parked(t, cashierTok, reviewKey, map[string]any{"orderId": id, "orderNumber": number, "originalShiftId": shift})
			exec(`INSERT INTO operation_receipts(idempotency_key,op_type,scope,fingerprint,outcome) VALUES($1,'void','x','f','{}'::jsonb)`, reviewKey)
			wantClosed(t, sendItem(cashierTok, closeItem(shift)), shift)
		})
		t.Run("unattributed_matched_through_the_sale", func(t *testing.T) {
			for _, byUUID := range []bool{false, true} {
				shift := openShift()
				id, uuid, number := saleIn(shift)
				payload := map[string]any{"orderNumber": number, "originalShiftId": nil}
				if byUUID {
					payload["saleOrderUuid"] = uuid
				} else {
					payload["orderId"] = id
				}
				parked(t, cashierTok, keyOf(), payload)
				wantBlocked(t, sendItem(cashierTok, closeItem(shift)), shift)
			}
		})
		t.Run("sale_of_another_shift_or_already_cancelled_does_not_block", func(t *testing.T) {
			old := openShift()
			oldID, _, oldNumber := saleIn(old)
			shift := openShift() // closes the older shift
			parked(t, cashierTok, keyOf(), map[string]any{"orderId": oldID, "orderNumber": oldNumber})
			cancelledID, _, cancelledNumber := saleIn(shift)
			exec(`UPDATE orders SET status='cancelled' WHERE id=$1`, cancelledID)
			parked(t, cashierTok, keyOf(), map[string]any{"orderId": cancelledID, "orderNumber": cancelledNumber})
			wantClosed(t, sendItem(cashierTok, closeItem(shift)), shift)
		})
		t.Run("another_outlets_report_does_not_block", func(t *testing.T) {
			shift := openShift()
			id, _, number := saleIn(shift)
			zTok, err := auth.IssueAccess(key, time.Hour, cashier, "cashier", outletZ, nil)
			if err != nil {
				t.Fatal(err)
			}
			parked(t, zTok, keyOf(), map[string]any{"orderId": id, "orderNumber": number, "originalShiftId": shift})
			wantClosed(t, sendItem(cashierTok, closeItem(shift)), shift)
		})
		t.Run("direct_close_and_current_shift_read", func(t *testing.T) {
			shift := openShift()
			id, _, number := saleIn(shift)
			reviewKey := keyOf()
			parked(t, cashierTok, reviewKey, map[string]any{"orderId": id, "orderNumber": number, "originalShiftId": shift})
			code, body := do(cashierTok, http.MethodGet, "/shifts/current", nil)
			data, _ := body["data"].(map[string]any)
			pending, _ := data["pendingVoidReviews"].([]any)
			if code != http.StatusOK || len(pending) != 1 || pending[0].(map[string]any)["orderNumber"] != number {
				t.Fatalf("current shift = %d %v, want pendingVoidReviews [%s]", code, body, number)
			}
			code, body = do(cashierTok, http.MethodPost, "/shifts/"+shift+"/close", map[string]any{"closingCash": 0})
			if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "Tinjauan Sinkron") {
				t.Fatalf("direct close = %d %v, want the 409 refusal naming Tinjauan Sinkron", code, body)
			}
			if str(`SELECT status FROM shifts WHERE id=$1`, shift) != "open" {
				t.Fatal("a refused direct close changed the shift")
			}
			exec(`UPDATE sync_review_items SET resolved_at=now(), resolved_by=$2, resolution_note='ok' WHERE idempotency_key=$1`, reviewKey, adminU)
			code, body = do(cashierTok, http.MethodGet, "/shifts/current", nil)
			data, _ = body["data"].(map[string]any)
			if _, has := data["pendingVoidReviews"]; code != http.StatusOK || (has && len(data["pendingVoidReviews"].([]any)) != 0) {
				t.Fatalf("resolved: current shift = %d %v, want no pending list", code, body)
			}
			if code, body = do(cashierTok, http.MethodPost, "/shifts/"+shift+"/close", map[string]any{"closingCash": 0}); code != http.StatusOK {
				t.Fatalf("direct close after resolve = %d %v", code, body)
			}
		})
	})
}
