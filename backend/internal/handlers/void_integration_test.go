package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
		_, err := pool.Exec(ctx, `INSERT INTO order_voids(order_id,outlet_id,business_date,after_close,counted_in_close,source,authority,mode,reason_code,
		        original_total,original_payment_method,original_tenders,visit_reversed,erp_document_key)
		      VALUES(gen_random_uuid(),$1,current_date,false,false,'pos','own_shift','replace','salah_barang',1,'cash','[]'::jsonb,false,'x')`, outlet)
		if err == nil {
			t.Fatal("mode replace without a replacement order was accepted")
		}
	})
}
