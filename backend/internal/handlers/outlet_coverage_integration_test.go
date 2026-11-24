package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
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
		router.Get("/products/{id}", h.Product)
		call := func(path, uid, home string, cov coverage.Coverage, header string) *httptest.ResponseRecorder {
			t.Helper()
			tok, err := auth.IssueAccessCov(secret, time.Hour, uid, "manager", home, nil, 0, cov)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("GET", path, nil)
			r.Header.Set("Authorization", "Bearer "+tok)
			if header != "" {
				r.Header.Set("X-Outlet-Id", header)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			return w
		}
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
		// Unassigned manager: refused on both endpoints, never a cross-outlet or empty-outlet read.
		for _, path := range []string{"/products", "/products/" + prod} {
			if w := call(path, mgr4, "", coverage.Coverage{}, ""); w.Code != 403 {
				t.Fatalf("unassigned manager GET %s = %d %s, want 403", path, w.Code, w.Body.String())
			}
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
	// ---- user admin API writes coverage (Task 4) ---------------------------------
	const outC = "00000000-0000-4000-8f20-000000000003"
	exec(`INSERT INTO outlets(id,name,code) VALUES ($1,'OCV C','OCC')`, outC)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	rc := redis.NewClient(&redis.Options{Addr: miniredis.RunT(t).Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	pv := auth.NewPermVersions(cache.NewFromClient(rc), store.LoadPermVersion, auth.PermVersionOptions{})
	store.Versions = pv
	h := New(rd, nil, store, wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("OCV-SYNTHETIC-TEST-KEY")
	api := chi.NewRouter()
	api.Post("/users", h.CreateUser)
	api.Put("/users/{id}", h.UpdateUser)
	api.Get("/users/{id}", h.GetUser)
	guarded := chi.NewRouter()
	guarded.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}, mw.WithRevocation(pv)))
	guarded.Get("/products", h.Products)

	type userData struct {
		ID         string   `json:"id"`
		OutletID   *string  `json:"outletId"`
		OutletIDs  []string `json:"outletIds"`
		AllOutlets bool     `json:"allOutlets"`
	}
	send := func(method, path string, body any) (int, string, userData) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		var out struct {
			Data  userData `json:"data"`
			Error string   `json:"error"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out.Error, out.Data
	}
	permVersion := func(uid string) int64 {
		t.Helper()
		var v int64
		if err := pool.QueryRow(ctx, `SELECT perm_version FROM users WHERE id=$1`, uid).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	seq := 0
	create := func(role string, extra map[string]any) userData {
		t.Helper()
		seq++
		body := map[string]any{
			"email": fmt.Sprintf("ocv-api%d@example.invalid", seq), "password": "Ocv-synthetic-pw-1",
			"displayName": fmt.Sprintf("API %d", seq), "role": role,
		}
		for k, v := range extra {
			body[k] = v
		}
		code, errText, u := send("POST", "/users", body)
		if code != 201 {
			t.Fatalf("create %s %v = %d %q", role, extra, code, errText)
		}
		return u
	}
	wantErr := func(label string, code int, errText string, wantCode int, wantText string) {
		t.Helper()
		if code != wantCode || errText != wantText {
			t.Fatalf("%s = %d %q, want %d %q", label, code, errText, wantCode, wantText)
		}
	}

	t.Run("create carries coverage and validates", func(t *testing.T) {
		m := create("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}})
		if m.AllOutlets || !reflect.DeepEqual(m.OutletIDs, []string{outA, outB}) {
			t.Fatalf("manager [A,B] = all=%v ids=%v", m.AllOutlets, m.OutletIDs)
		}
		all := create("manager", map[string]any{"allOutlets": true})
		if !all.AllOutlets || all.OutletIDs == nil || len(all.OutletIDs) != 0 || all.OutletID != nil {
			t.Fatalf("manager all = %+v", all)
		}
		c := create("cashier", map[string]any{"outletId": outA})
		if !reflect.DeepEqual(c.OutletIDs, []string{outA}) {
			t.Fatalf("cashier ids = %v", c.OutletIDs)
		}
		adm := create("admin", nil)
		if adm.AllOutlets || len(adm.OutletIDs) != 0 {
			t.Fatalf("admin = %+v", adm)
		}
		body := func(role string, extra map[string]any) map[string]any {
			seq++
			b := map[string]any{"email": fmt.Sprintf("ocv-api%d@example.invalid", seq), "password": "Ocv-synthetic-pw-1",
				"displayName": "Bad", "role": role}
			for k, v := range extra {
				b[k] = v
			}
			return b
		}
		code, e, _ := send("POST", "/users", body("cashier", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}}))
		wantErr("cashier [A,B]", code, e, 400, "Kasir harus ditempatkan di tepat satu outlet.")
		code, e, _ = send("POST", "/users", body("manager", map[string]any{}))
		wantErr("manager nothing", code, e, 400, "Manajer perlu Semua Outlet atau minimal satu outlet.")
		code, e, _ = send("POST", "/users", body("manager", map[string]any{"outletId": outC, "outletIds": []string{outA, outB}}))
		wantErr("home outside list", code, e, 400, "Outlet utama harus termasuk outlet yang dicakup.")
		code, e, _ = send("POST", "/users", body("admin", map[string]any{"allOutlets": true}))
		wantErr("admin all", code, e, 400, "Admin tidak memakai daftar outlet.")
		code, e, _ = send("POST", "/users", body("manager", map[string]any{"outletId": outA, "allOutlets": true}))
		wantErr("all with home", code, e, 400, "Semua Outlet tidak bisa digabung dengan outlet utama.")
		code, e, _ = send("POST", "/users", body("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, "00000000-0000-4000-8f20-0000000000ff"}}))
		wantErr("unknown outlet", code, e, 400, "Outlet tidak ditemukan.")
	})

	t.Run("update coverage bumps perm_version and refuses the old token", func(t *testing.T) {
		m := create("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}})
		before := permVersion(m.ID)
		cov := coverage.Coverage{OutletIDs: []string{outA, outB}}
		oldTok, err := auth.IssueAccessCov(secret, time.Hour, m.ID, "manager", outA, nil, before, cov)
		if err != nil {
			t.Fatal(err)
		}
		getOutlet := func(tok, outlet string) (int, string) {
			r := httptest.NewRequest("GET", "/products", nil)
			r.Header.Set("Authorization", "Bearer "+tok)
			r.Header.Set("X-Outlet-Id", outlet)
			w := httptest.NewRecorder()
			guarded.ServeHTTP(w, r)
			return w.Code, w.Body.String()
		}
		get := func(tok string) int {
			code, _ := getOutlet(tok, outB)
			return code
		}
		if got := get(oldTok); got != 200 {
			t.Fatalf("before the change: %d", got)
		}
		code, e, u := send("PUT", "/users/"+m.ID, map[string]any{"outletIds": []string{outA}})
		if code != 200 || !reflect.DeepEqual(u.OutletIDs, []string{outA}) {
			t.Fatalf("update to [A] = %d %q ids=%v", code, e, u.OutletIDs)
		}
		if got := permVersion(m.ID); got != before+1 {
			t.Fatalf("perm_version %d, want %d", got, before+1)
		}
		// The 401 is the refreshable one; a 403 would never make the client refresh.
		if got := get(oldTok); got != 401 {
			t.Fatalf("old token with X-Outlet-Id B = %d, want 401 (revoked)", got)
		}
		// The client refreshes and retries: the new token carries the new coverage, so B is
		// now a 403 and the home outlet still works.
		au, err := store.ByID(ctx, m.ID)
		if err != nil {
			t.Fatal(err)
		}
		newTok, err := auth.IssueAccessCov(secret, time.Hour, m.ID, "manager", au.OutletID, nil, au.PermVersion, au.Coverage())
		if err != nil {
			t.Fatal(err)
		}
		if code, body := getOutlet(newTok, outB); code != 403 || !strings.Contains(body, "outlet not permitted") {
			t.Fatalf("refreshed token with X-Outlet-Id B = %d %q, want 403 outlet not permitted", code, body)
		}
		if code, body := getOutlet(newTok, outA); code != 200 {
			t.Fatalf("refreshed token with home outlet = %d %q, want 200", code, body)
		}
		// An unchanged list does not bump.
		if code, e, _ := send("PUT", "/users/"+m.ID, map[string]any{"outletIds": []string{outA}}); code != 200 {
			t.Fatalf("same list = %d %q", code, e)
		}
		if got := permVersion(m.ID); got != before+1 {
			t.Fatalf("an unchanged list bumped perm_version to %d", got)
		}
	})

	t.Run("open shift guards dropping a covered outlet", func(t *testing.T) {
		m := create("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}})
		exec(`INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at)
		      VALUES($1,$2,'API','open',now())`, outB, m.ID)
		code, e, _ := send("PUT", "/users/"+m.ID, map[string]any{"outletIds": []string{outA}})
		wantErr("drop B with an open shift", code, e, 409, auth.ErrOpenShiftMove.Error())
		if code, e, u := send("PUT", "/users/"+m.ID, map[string]any{"outletIds": []string{outA, outB, outC}}); code != 200 ||
			!reflect.DeepEqual(u.OutletIDs, []string{outA, outB, outC}) {
			t.Fatalf("adding C = %d %q ids=%v", code, e, u.OutletIDs)
		}
		// Moving the home off A is the unchanged home-move rule, still refused with an open shift.
		code, e, _ = send("PUT", "/users/"+m.ID, map[string]any{"outletId": nil, "outletIds": []string{}, "allOutlets": true})
		wantErr("to all-outlets (home cleared) with an open shift", code, e, 409, auth.ErrOpenShiftMove.Error())
	})

	t.Run("all outlets bumps and strict merged validation", func(t *testing.T) {
		m := create("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}})
		before := permVersion(m.ID)
		code, e, u := send("PUT", "/users/"+m.ID, map[string]any{"outletId": nil, "outletIds": []string{}, "allOutlets": true})
		if code != 200 || !u.AllOutlets || u.OutletID != nil || len(u.OutletIDs) != 0 {
			t.Fatalf("all on = %d %q %+v", code, e, u)
		}
		if got := permVersion(m.ID); got != before+1 {
			t.Fatalf("turning all outlets on: perm_version %d, want %d", got, before+1)
		}
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_outlets WHERE user_id=$1`, m.ID).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("extras left behind after all outlets: %d %v", rows, err)
		}
		// Home plus the flag in one request: refused, never the 23514 CHECK as a 500.
		code, e, _ = send("PUT", "/users/"+m.ID, map[string]any{"outletId": outA})
		wantErr("home while all-outlets", code, e, 400, "Semua Outlet tidak bisa digabung dengan outlet utama.")
		// Role change to cashier keeps the extras it would carry: strict, no silent clearing.
		x := create("manager", map[string]any{"outletId": outA, "outletIds": []string{outA, outB}})
		code, e, _ = send("PUT", "/users/"+x.ID, map[string]any{"role": "cashier"})
		wantErr("manager with extras to cashier", code, e, 400, "Kasir harus ditempatkan di tepat satu outlet.")
		if code, e, u := send("PUT", "/users/"+x.ID, map[string]any{"role": "cashier", "outletIds": []string{outA}}); code != 200 ||
			!reflect.DeepEqual(u.OutletIDs, []string{outA}) {
			t.Fatalf("to cashier with [A] = %d %q ids=%v", code, e, u.OutletIDs)
		}
		// A legacy manager with no outlet at all cannot be saved without choosing.
		const legacy = "00000000-0000-4000-8f20-0000000000c1"
		exec(`INSERT INTO users(id,email,password_hash,display_name,role)
		      VALUES($1,'ocv-legacy@example.invalid','x','Legacy','manager')`, legacy)
		code, e, _ = send("PUT", "/users/"+legacy, map[string]any{"displayName": "Legacy 2"})
		wantErr("legacy manager edited without choosing", code, e, 400, "Manajer perlu Semua Outlet atau minimal satu outlet.")
		if code, e, u := send("PUT", "/users/"+legacy, map[string]any{"outletId": outB, "outletIds": []string{outB}}); code != 200 ||
			!reflect.DeepEqual(u.OutletIDs, []string{outB}) {
			t.Fatalf("legacy manager after choosing = %d %q ids=%v", code, e, u.OutletIDs)
		}
	})

	t.Run("users API and auth agree on coverage", func(t *testing.T) {
		rows, err := pool.Query(ctx, `SELECT id::text FROM users WHERE email LIKE 'ocv-%@example.invalid'`)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		rows.Close()
		if len(ids) < 8 {
			t.Fatalf("expected a spread of users, got %d", len(ids))
		}
		for _, id := range ids {
			au, err := store.ByID(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			u, err := rd.User(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, len(u.OutletIds))
			for i, o := range u.OutletIds {
				got[i] = o.String()
			}
			if u.AllOutlets != au.AllOutlets || !reflect.DeepEqual(got, au.OutletIDs) {
				t.Fatalf("%s (%s): users API all=%v ids=%v, auth all=%v ids=%v", au.Email, au.Role, u.AllOutlets, got, au.AllOutlets, au.OutletIDs)
			}
		}
	})

	// ---- sync, approvals and receive follow coverage (Task 5) ---------------------
	const (
		outD     = "00000000-0000-4000-8f20-000000000004"
		outE     = "00000000-0000-4000-8f20-000000000005"
		prodX    = "00000000-0000-4000-8f20-0000000000b1"
		homeless = "00000000-0000-4000-8f20-000000000016"
	)
	exec(`INSERT INTO outlets(id,name,code) VALUES ($1,'OCV D','OCD'),($2,'OCV E','OCE')`, outD, outE)
	exec(`INSERT INTO products(id,name) VALUES($1,'OCV approval product')`, prodX)
	exec(`INSERT INTO product_variants(product_id,size,price,sku) VALUES($1,'M',1000,'OCV-X')`, prodX)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',10)`, outE, prodX)
	exec(`UPDATE app_settings SET receive_approver_roles='{manager}' WHERE id=1`)
	withCtx := func(r *http.Request, uid, outlet string) *http.Request {
		c := context.WithValue(r.Context(), auth.CtxUserID, uid)
		if outlet != "" {
			c = context.WithValue(c, auth.CtxOutletID, outlet)
		}
		return r.WithContext(c)
	}

	t.Run("coverage.Load reads role, home and coverage", func(t *testing.T) {
		role, home, cov, err := coverage.Load(ctx, pool, mgr1)
		if err != nil || role != "manager" || home != outA || cov.All || !reflect.DeepEqual(cov.OutletIDs, []string{outA, outB}) {
			t.Fatalf("manager [A,B] = %q %q %+v %v", role, home, cov, err)
		}
		role, home, cov, err = coverage.Load(ctx, pool, mgr2)
		if err != nil || role != "manager" || home != "" || !cov.All {
			t.Fatalf("manager-all = %q %q %+v %v", role, home, cov, err)
		}
		if _, _, _, err = coverage.Load(ctx, pool, "00000000-0000-4000-8f20-0000000000ff"); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown user err = %v, want pgx.ErrNoRows", err)
		}
	})

	t.Run("sync attributes and opens shifts at covered outlets only", func(t *testing.T) {
		m := create("manager", map[string]any{"outletId": outD, "outletIds": []string{outD, outE}})
		eng := syncpkg.New(pool, rd, svc, wr)
		batch := func(uid, home string, items ...map[string]any) []map[string]any {
			t.Helper()
			raw, _ := json.Marshal(map[string]any{"items": items})
			r := withCtx(httptest.NewRequest("POST", "/sync", bytes.NewReader(raw)), uid, home)
			w := httptest.NewRecorder()
			h.syncBatch(w, r, h.caller, eng.ProcessBatch)
			if w.Code != 200 {
				t.Fatalf("sync = %d %s", w.Code, w.Body.String())
			}
			var out struct {
				Data struct {
					Results []map[string]any `json:"results"`
				} `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			return out.Data.Results
		}
		item := func(typ, key, uid, outlet string, payload map[string]any) map[string]any {
			return map[string]any{
				"type": typ, "idempotencyKey": "ocvdev:" + key, "payload": payload,
				"envelope": map[string]any{"v": 1, "outletId": outlet, "userId": uid, "deviceId": "ocvdev", "capturedAt": time.Now().UTC()},
			}
		}
		status := func(res []map[string]any, i int) string { s, _ := res[i]["status"].(string); return s }

		// Covered extra outlet E opens; uncovered outlet C is refused before any write.
		res := batch(m.ID, outD,
			item("shift_open", "00000000-0000-4000-8f20-0000000001e1", m.ID, outE, map[string]any{"startingCash": 0}),
			item("shift_open", "00000000-0000-4000-8f20-0000000001c1", m.ID, outC, map[string]any{"startingCash": 0}))
		if status(res, 0) != "ok" || status(res, 1) != "error" {
			t.Fatalf("manager [D,E] open E/C = %v", res)
		}
		var shiftE string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM shifts WHERE outlet_id=$1 AND cashier_id=$2 AND status='open'`, outE, m.ID).Scan(&shiftE); err != nil {
			t.Fatalf("shift at E not opened: %v", err)
		}
		var nC int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM shifts WHERE outlet_id=$1 AND cashier_id=$2`, outC, m.ID).Scan(&nC); err != nil || nC != 0 {
			t.Fatalf("shift at uncovered C: n=%d err=%v", nC, err)
		}
		// The same manager closes it at E.
		res = batch(m.ID, outD, item("shift_close", "00000000-0000-4000-8f20-0000000001e2", m.ID, outE, map[string]any{"shiftId": shiftE, "closingCash": 0}))
		if status(res, 0) != "ok" {
			t.Fatalf("close at E = %v", res)
		}
		var st string
		if err := pool.QueryRow(ctx, `SELECT status FROM shifts WHERE id=$1`, shiftE).Scan(&st); err != nil || st != "closed" {
			t.Fatalf("shift E status=%q err=%v", st, err)
		}
		// A cashier covers only the home outlet; an all-outlets manager reaches any existing outlet.
		c := create("cashier", map[string]any{"outletId": outD})
		res = batch(c.ID, outD, item("shift_open", "00000000-0000-4000-8f20-0000000001e3", c.ID, outE, map[string]any{"startingCash": 0}))
		if status(res, 0) != "error" {
			t.Fatalf("cashier opening at E = %v", res)
		}
		res = batch(mgr2, outC, item("shift_open", "00000000-0000-4000-8f20-0000000001e4", mgr2, outC, map[string]any{"startingCash": 0}))
		if status(res, 0) != "ok" {
			t.Fatalf("manager-all opening at C = %v", res)
		}
	})

	t.Run("approvals and the receive approver list follow coverage", func(t *testing.T) {
		inD := create("manager", map[string]any{"outletId": outD})
		inDE := create("manager", map[string]any{"outletId": outD, "outletIds": []string{outD, outE}})
		all := create("manager", map[string]any{"allOutlets": true})
		// Unassigned manager (no home) with a stale extra row: enforced coverage is empty.
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
		      VALUES($1,'ocv-m5@example.invalid','x','M5','manager',NULL)`, homeless)
		exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2)`, homeless, outE)
		for _, id := range []string{inD.ID, inDE.ID, all.ID, homeless} {
			exec(`UPDATE users SET receive_pin_hash='x', receive_pin_set_at=now() WHERE id=$1`, id)
		}
		got, err := rd.ReceiveApprovingUsers(ctx, outE)
		if err != nil {
			t.Fatal(err)
		}
		listed := map[string]bool{}
		for _, a := range got {
			listed[a.UserId.String()] = true
		}
		if !listed[inDE.ID] || !listed[all.ID] || listed[inD.ID] || listed[homeless] {
			t.Fatalf("approvers at E = %v", listed)
		}

		// Inventory approval: a manager covering E may reject an E document, one covering only D may not.
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		docID, err := wr.CreateAdjustmentRequestTx(ctx, tx, csh1, write.AdjustmentRequestInput{
			LocationType: "outlet", LocationID: outE, ProductID: prodX, VariantSize: "M", NewQty: 5,
			ReasonCode: "other", ReasonText: "ocv coverage",
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		reject := func(uid string) error {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if err := wr.RejectAdjustmentRequestTx(ctx, tx, docID, uid, "ocv"); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		if err := reject(inD.ID); err == nil || err.Error() != "tidak berwenang" {
			t.Fatalf("manager covering only D rejecting an E document = %v, want tidak berwenang", err)
		}
		if err := reject(inDE.ID); err != nil {
			t.Fatalf("manager covering E rejecting = %v", err)
		}
	})

	t.Run("refund and void from the combined view stay admin-only", func(t *testing.T) {
		router := chi.NewRouter()
		router.Post("/orders/{id}/refund", h.RefundOrder)
		router.Post("/orders/{id}/void", h.VoidOrder)
		const order = "00000000-0000-4000-8f20-0000000000c1"
		for _, tc := range []struct{ path, body string }{
			{"/orders/" + order + "/refund", `{"reason":"pengembalian pelanggan"}`},
			{"/orders/" + order + "/void", `{"reasonCode":"other","note":"x","clientVoidUuid":"00000000-0000-4000-8f20-0000000000c2"}`},
		} {
			r := withCtx(httptest.NewRequest("POST", tc.path, bytes.NewReader([]byte(tc.body))), mgr2, "")
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			var out struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &out)
			if w.Code != 403 || out.Error != "Outlet aktif belum dipilih untuk akun ini." {
				t.Fatalf("%s as manager-all without an active outlet = %d %q", tc.path, w.Code, out.Error)
			}
		}
	})
}
