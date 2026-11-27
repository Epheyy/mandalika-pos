package handlers

import (
	"os"
	"strings"
	"testing"
)

// migrationDataBlock returns the re-runnable data statements of migration 0104 (between the
// migrate:data-begin / migrate:data-end markers).
func migrationDataBlock(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	i := strings.Index(s, "-- migrate:data-begin")
	j := strings.Index(s, "-- migrate:data-end")
	if i < 0 || j < i {
		t.Fatal("data markers missing in " + file)
	}
	return s[i:j]
}

// TestSalesStaffPostgres is gate SS (isolated cluster, MANDALIKA_SS_TEST_DSN, port 26489): the Tim Sales
// per-outlet sales staff list.
func TestSalesStaffPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "SS", 26489)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
	}
	count := func(sql string, args ...any) (n int) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return
	}
	const (
		o1    = "00000000-0000-4000-8f89-0000000000a1"
		o2    = "00000000-0000-4000-8f89-0000000000a2"
		uA    = "00000000-0000-4000-8f89-0000000000b1"
		uB    = "00000000-0000-4000-8f89-0000000000b2"
		uC    = "00000000-0000-4000-8f89-0000000000b3"
		uCash = "00000000-0000-4000-8f89-0000000000b4"
		ghost = "00000000-0000-4000-8f89-0000000000b9"
	)

	t.Run("migration", func(t *testing.T) {
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'SS outlet 1','ss-1','SS1'),($2,'SS outlet 2','ss-2','SS2')`, o1, o2)
		for _, u := range []struct{ id, role, name, email string }{
			{uA, "cashier", "", "ssa"}, {uB, "cashier", strings.Repeat("x", 80), "ssb"},
			{uC, "manager", "SS manager", "ssc"}, {uCash, "cashier", "SS cashier", "ssd"},
		} {
			exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,$5)`,
				u.id, u.email+"@example.invalid", u.name, u.role, o1)
		}
		exec(`INSERT INTO custom_roles(id,name) VALUES('00000000-0000-4000-8f89-0000000000e1','Manajer Area'),('00000000-0000-4000-8f89-0000000000e2','Kasir X')`)
		for i, o := range []struct{ outlet, salesman string }{{o1, uA}, {o2, uA}, {o1, uB}, {o1, ghost}} {
			id := "00000000-0000-4000-8f89-00000000010" + string(rune('1'+i))
			exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,salesman_id,
			        subtotal,discount_amount,total,payment_method,status)
			      VALUES($1::uuid,$1::uuid,$1::text,$1::text,$2,$3,'SS cashier',$4,1000,0,1000,'cash','completed')`, id, o.outlet, uCash, o.salesman)
		}

		block := migrationDataBlock(t, "../db/migrations/0104_sales_staff.sql")
		exec(block)

		if n := count(`SELECT count(*) FROM sales_staff`); n != 2 {
			t.Fatalf("sales_staff rows = %d, want 2", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE active`); n != 0 {
			t.Fatalf("active rows = %d, want 0", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE user_id=$1 AND name='Sales'`, uA); n != 1 {
			t.Fatal("A's empty display_name must become 'Sales'")
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE user_id=$1 AND name=$2`, uB, strings.Repeat("x", 60)); n != 1 {
			t.Fatal("B's name must be cut to 60 chars")
		}
		if n := count(`SELECT count(*) FROM sales_staff_outlets so JOIN sales_staff s ON s.id=so.staff_id
		               WHERE s.user_id=$1 AND so.outlet_id IN ($2,$3)`, uA, o1, o2); n != 2 {
			t.Fatalf("A outlets = %d, want 2", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff_outlets so JOIN sales_staff s ON s.id=so.staff_id WHERE s.user_id=$1`, uB); n != 1 {
			t.Fatalf("B outlets = %d, want 1", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff_outlets`); n != 3 {
			t.Fatalf("total outlet links = %d, want 3", n)
		}

		// Idempotent insert statements: a second run adds no staff or links.
		exec(block)
		if n := count(`SELECT count(*) FROM sales_staff`); n != 2 {
			t.Fatalf("sales_staff after re-run = %d, want 2", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff_outlets`); n != 3 {
			t.Fatalf("links after re-run = %d, want 3", n)
		}

		// Grants: manager yes, cashier no; custom role by name.
		if n := count(`SELECT count(*) FROM user_permissions WHERE user_id=$1 AND permission='manage_sales_staff'`, uC); n != 1 {
			t.Fatal("manager must hold manage_sales_staff")
		}
		if n := count(`SELECT count(*) FROM user_permissions WHERE user_id=$1 AND permission='manage_sales_staff'`, uCash); n != 0 {
			t.Fatal("cashier must not hold manage_sales_staff")
		}
		if n := count(`SELECT count(*) FROM custom_role_permissions WHERE permission='manage_sales_staff' AND role_id='00000000-0000-4000-8f89-0000000000e1'`); n != 1 {
			t.Fatal("manager-named custom role must hold manage_sales_staff")
		}
		if n := count(`SELECT count(*) FROM custom_role_permissions WHERE permission='manage_sales_staff' AND role_id='00000000-0000-4000-8f89-0000000000e2'`); n != 0 {
			t.Fatal("cashier-named custom role must not hold manage_sales_staff")
		}

		// Content-version bump for every outlet.
		for _, o := range []string{o1, o2} {
			if n := count(`SELECT count(*) FROM content_versions WHERE outlet_id=$1 AND (data_manifest->>'sales_staff')::int >= 1`, o); n != 1 {
				t.Fatalf("content version for %s not bumped", o)
			}
		}
	})
}
