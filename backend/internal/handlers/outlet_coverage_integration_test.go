package handlers

import (
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
)

// Multi-outlet coverage: opt-in fresh synthetic cluster (port 26484, prefix OCV).
func TestOutletCoveragePostgres(t *testing.T) {
	pool, ctx := gatePool(t, "OCV", 26484)
	const (
		outA = "00000000-0000-4000-8f20-000000000001"
		outB = "00000000-0000-4000-8f20-000000000002"
		mgr1 = "00000000-0000-4000-8f20-000000000011"
		mgr2 = "00000000-0000-4000-8f20-000000000012"
		csh1 = "00000000-0000-4000-8f20-000000000013"
		mgr3 = "00000000-0000-4000-8f20-000000000014"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO outlets(id,name,code) VALUES ($1,'OCV A','OCA'),($2,'OCV B','OCB')`, outA, outB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
	      VALUES($1,'ocv-m1@example.invalid','x','M1','manager',$2)`, mgr1, outA)
	exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2)`, mgr1, outB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id,all_outlets)
	      VALUES($1,'ocv-m2@example.invalid','x','M2','manager',NULL,true)`, mgr2)
	store := auth.NewStore(pool)

	t.Run("user coverage loaded", func(t *testing.T) {
		u, err := store.ByID(ctx, mgr1)
		if err != nil {
			t.Fatal(err)
		}
		if u.AllOutlets || !reflect.DeepEqual(u.OutletIDs, []string{outA, outB}) {
			t.Fatalf("m1 = all=%v ids=%v", u.AllOutlets, u.OutletIDs)
		}
		u, err = store.ByID(ctx, mgr2)
		if err != nil {
			t.Fatal(err)
		}
		if !u.AllOutlets || u.OutletIDs == nil || len(u.OutletIDs) != 0 {
			t.Fatalf("m2 = all=%v ids=%#v", u.AllOutlets, u.OutletIDs)
		}
		if !u.Coverage().Covers(outB) {
			t.Fatal("all-outlets manager must cover every outlet")
		}
	})

	t.Run("wire fields follow enforced coverage", func(t *testing.T) {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
		      VALUES($1,'ocv-c1@example.invalid','x','C1','cashier',$2)`, csh1, outA)
		exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2)`, csh1, outB)
		u, err := store.ByID(ctx, csh1)
		if err != nil {
			t.Fatal(err)
		}
		if u.AllOutlets || !reflect.DeepEqual(u.OutletIDs, []string{outA}) {
			t.Fatalf("cashier = all=%v ids=%v", u.AllOutlets, u.OutletIDs)
		}
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
		      VALUES($1,'ocv-m3@example.invalid','x','M3','manager',NULL)`, mgr3)
		exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2)`, mgr3, outB)
		u, err = store.ByID(ctx, mgr3)
		if err != nil {
			t.Fatal(err)
		}
		if u.AllOutlets || u.OutletIDs == nil || len(u.OutletIDs) != 0 || u.Coverage().Covers(outB) {
			t.Fatalf("home-less manager = all=%v ids=%#v", u.AllOutlets, u.OutletIDs)
		}
	})

	t.Run("all_outlets excludes a home outlet", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE users SET outlet_id=$1 WHERE id=$2`, outA, mgr2); err == nil {
			t.Fatal("CHECK users_all_outlets_no_home should reject home + all_outlets")
		}
	})
}
