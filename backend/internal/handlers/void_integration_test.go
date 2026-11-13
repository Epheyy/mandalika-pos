package handlers

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/ledger"
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
		obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		for _, k := range []string{voidDoc, "sale:vd-erp-repl", "refund:vd-erp-repl"} {
			if r := get(k); r.status != "held" {
				t.Fatalf("%s status after a relay run = %s, want held", k, r.status)
			}
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
}
