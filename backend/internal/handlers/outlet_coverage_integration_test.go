package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/coverage"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
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
	t.Run("read scope fails closed and manager-all reads cross-outlet", func(t *testing.T) {
		const prod = "00000000-0000-4000-8f20-0000000000a1"
		const mgr4 = "00000000-0000-4000-8f20-000000000015"
		exec(`INSERT INTO products(id,name) VALUES($1,'OCV product')`, prod)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'50ml',100000,7,'OCV1')`, prod)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'50ml',3),($3,$2,'50ml',4)`, outA, prod, outB)
		exec(`INSERT INTO users(id,email,password_hash,display_name,role)
		      VALUES($1,'ocv-m4@example.invalid','x','M4','manager')`, mgr4)

		rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
		h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
		secret := []byte("OCV-SYNTHETIC-TEST-KEY")
		router := chi.NewRouter()
		router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
		router.Get("/products", h.Products)
		stockSeen := func(uid, home string, cov coverage.Coverage, header string) int {
			t.Helper()
			tok, err := auth.IssueAccessCov(secret, time.Hour, uid, "manager", home, nil, 0, cov)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("GET", "/products", nil)
			r.Header.Set("Authorization", "Bearer "+tok)
			if header != "" {
				r.Header.Set("X-Outlet-Id", header)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("GET /products = %d %s", w.Code, w.Body.String())
			}
			var body struct {
				Data []struct {
					Variants []struct {
						Stock int `json:"stock"`
					} `json:"variants"`
				} `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Data) != 1 || len(body.Data[0].Variants) != 1 {
				t.Fatalf("unexpected catalogue: %s", w.Body.String())
			}
			return body.Data[0].Variants[0].Stock
		}
		// Unassigned manager: scoped to no outlet, so no outlet's stock leaks (0, not 7).
		if got := stockSeen(mgr4, "", coverage.Coverage{}, ""); got != 0 {
			t.Fatalf("unassigned manager saw stock %d, want 0", got)
		}
		// All-outlets manager without a header: cross-outlet (summed) catalogue.
		if got := stockSeen(mgr2, "", coverage.Coverage{All: true}, ""); got != 7 {
			t.Fatalf("manager-all saw stock %d, want 7", got)
		}
		// A manager covering [A,B] with active outlet B sees only B.
		if got := stockSeen(mgr1, outA, coverage.Coverage{OutletIDs: []string{outA, outB}}, outB); got != 4 {
			t.Fatalf("manager [A,B] active B saw stock %d, want 4", got)
		}
	})
}
