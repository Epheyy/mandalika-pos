package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/coverage"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
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
		uD    = "00000000-0000-4000-8f89-0000000000b5"
		ghost = "00000000-0000-4000-8f89-0000000000b9"
	)

	t.Run("migration", func(t *testing.T) {
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'SS outlet 1','ss-1','SS1'),($2,'SS outlet 2','ss-2','SS2')`, o1, o2)
		for _, u := range []struct{ id, role, name, email string }{
			{uA, "cashier", "", "ssa"}, {uB, "cashier", strings.Repeat("x", 80), "ssb"},
			{uC, "manager", "SS manager", "ssc"}, {uCash, "cashier", "SS cashier", "ssd"},
			{uD, "cashier", "", "sse"},
		} {
			exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,$5)`,
				u.id, u.email+"@example.invalid", u.name, u.role, o1)
		}
		exec(`INSERT INTO custom_roles(id,name) VALUES('00000000-0000-4000-8f89-0000000000e1','Manajer Area'),('00000000-0000-4000-8f89-0000000000e2','Kasir X')`)
		// A's newest non-blank salesman_name wins; D has only blank names; ghost has no user row.
		for i, o := range []struct{ outlet, salesman, name, at string }{
			{o1, uA, "Old", "2026-11-01T03:00:00Z"}, {o2, uA, "Ani", "2026-11-02T03:00:00Z"},
			{o1, uA, "  ", "2026-11-03T03:00:00Z"}, {o1, uB, "", "2026-11-01T03:00:00Z"},
			{o1, ghost, "", "2026-11-01T03:00:00Z"}, {o1, uD, "   ", "2026-11-01T03:00:00Z"},
		} {
			id := "00000000-0000-4000-8f89-00000000010" + string(rune('1'+i))
			exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,salesman_id,salesman_name,
			        subtotal,discount_amount,total,payment_method,status,created_at)
			      VALUES($1::uuid,$1::uuid,$1::text,$1::text,$2,$3,'SS cashier',$4,NULLIF($5,''),1000,0,1000,'cash','completed',$6::timestamptz)`,
				id, o.outlet, uCash, o.salesman, o.name, o.at)
		}

		block := migrationDataBlock(t, "../db/migrations/0104_sales_staff.sql")
		exec(block)

		if n := count(`SELECT count(*) FROM sales_staff`); n != 3 {
			t.Fatalf("sales_staff rows = %d, want 3", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE active`); n != 0 {
			t.Fatalf("active rows = %d, want 0", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE user_id=$1 AND name='Ani'`, uA); n != 1 {
			t.Fatal("A's empty display_name must fall back to the newest non-blank order salesman_name 'Ani'")
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE user_id=$1 AND name='Sales'`, uD); n != 1 {
			t.Fatal("D's empty display_name and blank order names must become 'Sales'")
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
		if n := count(`SELECT count(*) FROM sales_staff_outlets`); n != 4 {
			t.Fatalf("total outlet links = %d, want 4", n)
		}

		// Idempotent insert statements: a second run adds no staff or links.
		exec(block)
		if n := count(`SELECT count(*) FROM sales_staff`); n != 3 {
			t.Fatalf("sales_staff after re-run = %d, want 3", n)
		}
		if n := count(`SELECT count(*) FROM sales_staff_outlets`); n != 4 {
			t.Fatalf("links after re-run = %d, want 4", n)
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
	// Repository subtests use their own outlets and users (fresh ids) and assert deltas only:
	// the migration subtest above leaves rows, grants and bumped versions in this cluster.
	const (
		pBSD, pLWB, pMKS = "00000000-0000-4000-8f89-000000000201", "00000000-0000-4000-8f89-000000000202", "00000000-0000-4000-8f89-000000000203"
		rAdmin           = "00000000-0000-4000-8f89-000000000211"
		rAll             = "00000000-0000-4000-8f89-000000000212"
		rBSDCash         = "00000000-0000-4000-8f89-000000000213"
		rExtra           = "00000000-0000-4000-8f89-000000000214"
		rLWBCash         = "00000000-0000-4000-8f89-000000000215"
		rNoHome          = "00000000-0000-4000-8f89-000000000216"
		rBSDMgr          = "00000000-0000-4000-8f89-000000000217"
		rLWBLink         = "00000000-0000-4000-8f89-000000000218"
	)
	exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'SS BSD','ss-bsd','SSB'),($2,'SS LWB','ss-lwb','SSL'),($3,'SS MKS','ss-mks','SSM')`, pBSD, pLWB, pMKS)
	for _, u := range []struct{ id, role, name, home string }{
		{rAdmin, "admin", "R Admin", ""}, {rAll, "manager", "R All", ""}, {rBSDCash, "cashier", "R BSD cashier", pBSD},
		{rExtra, "manager", "R Extra", pMKS}, {rLWBCash, "cashier", "R LWB cashier", pLWB},
		{rNoHome, "manager", "R NoHome", ""}, {rBSDMgr, "manager", "R BSD manager", pBSD}, {rLWBLink, "cashier", "R LWB link", pLWB},
	} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id,all_outlets)
		      VALUES($1,$2,'x',$3,$4,NULLIF($5,'')::uuid,$6)`, u.id, u.id+"@example.invalid", u.name, u.role, u.home, u.id == rAll)
	}
	exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2),($3,$2),($4,$2)`, rExtra, pBSD, rNoHome, rLWBCash)
	repo := write.New(pool)
	rd := read.New(pool)
	admin := coverage.Caller{UserID: rAdmin, Admin: true}
	bsdMgr := coverage.Caller{UserID: rBSDMgr, Cov: coverage.Coverage{OutletIDs: []string{pBSD}}}
	inTx := func(fn func(tx pgx.Tx) error) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := fn(tx); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		return tx.Commit(ctx)
	}
	create := func(c coverage.Caller, in write.SalesStaffInput) (id string, err error) {
		err = inTx(func(tx pgx.Tx) (e error) { id, e = repo.CreateSalesStaffTx(ctx, tx, c, in); return })
		return
	}
	update := func(c coverage.Caller, id string, in write.SalesStaffInput) error {
		return inTx(func(tx pgx.Tx) error { return repo.UpdateSalesStaffTx(ctx, tx, c, id, in) })
	}
	must := func(id string, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	version := func(outlet string) int {
		return count(`SELECT COALESCE((SELECT version FROM content_versions WHERE outlet_id=$1),0)`, outlet)
	}
	find := func(list []api.SalesStaff, id string) *api.SalesStaff {
		for i := range list {
			if list[i].Id.String() == id {
				return &list[i]
			}
		}
		return nil
	}
	outletsOf := func(id string) []string {
		rows, err := pool.Query(ctx, `SELECT outlet_id::text FROM sales_staff_outlets WHERE staff_id=$1 ORDER BY outlet_id`, id)
		if err != nil {
			t.Fatal(err)
		}
		got, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	t.Run("create_and_list", func(t *testing.T) {
		id := must(create(admin, write.SalesStaffInput{Name: "  Rina List ", Active: true, OutletIDs: []string{pBSD, pLWB}}))
		list, err := rd.SalesStaffList(ctx, bsdMgr, read.SalesStaffFilter{})
		if err != nil {
			t.Fatal(err)
		}
		s := find(list, id)
		if s == nil || s.Name != "Rina List" || s.HiddenOutletCount != 1 || s.CanEditDetails ||
			len(s.OutletIds) != 1 || s.OutletIds[0].String() != pBSD {
			t.Fatalf("BSD manager view = %+v", s)
		}
		all, err := rd.SalesStaffList(ctx, admin, read.SalesStaffFilter{})
		if err != nil {
			t.Fatal(err)
		}
		if a := find(all, id); a == nil || len(a.OutletIds) != 2 || a.HiddenOutletCount != 0 || !a.CanEditDetails {
			t.Fatalf("admin view = %+v", a)
		}
		if _, err := create(bsdMgr, write.SalesStaffInput{Name: "Wide", Active: true, OutletIDs: []string{pBSD, pLWB}}); !errors.Is(err, write.ErrSalesStaffForbidden) {
			t.Fatalf("manager creating beyond coverage: %v", err)
		}
		if _, err := create(admin, write.SalesStaffInput{Name: strings.Repeat("n", 61), Active: true, OutletIDs: []string{pBSD}}); !errors.Is(err, write.ErrSalesStaffInvalid) {
			t.Fatalf("61-char name: %v", err)
		}
		if _, err := create(admin, write.SalesStaffInput{Name: "Ghost outlet", Active: true, OutletIDs: []string{ghost}}); !errors.Is(err, write.ErrSalesStaffInvalid) {
			t.Fatalf("unknown outlet: %v", err)
		}
		if one, err := rd.SalesStaffByID(ctx, pool, bsdMgr, id); err != nil || one.Name != "Rina List" {
			t.Fatalf("ByID: %v %+v", err, one)
		}
		other := must(create(admin, write.SalesStaffInput{Name: "Only LWB", Active: true, OutletIDs: []string{pLWB}}))
		if _, err := rd.SalesStaffByID(ctx, pool, bsdMgr, other); !errors.Is(err, read.ErrNotFound) {
			t.Fatalf("invisible ByID: %v", err)
		}
	})

	t.Run("partial_manager", func(t *testing.T) {
		id := must(create(admin, write.SalesStaffInput{Name: "Rina Partial", Active: true, OutletIDs: []string{pBSD, pLWB}}))
		if err := update(bsdMgr, id, write.SalesStaffInput{Name: "Rini", Active: true, OutletIDs: []string{pBSD, pLWB}}); !errors.Is(err, write.ErrSalesStaffForbidden) {
			t.Fatalf("rename: %v", err)
		}
		if err := update(bsdMgr, id, write.SalesStaffInput{Name: "Rina Partial", Active: true, OutletIDs: []string{pBSD, pLWB, pMKS}}); !errors.Is(err, write.ErrSalesStaffForbidden) {
			t.Fatalf("add uncovered outlet: %v", err)
		}
		if err := update(bsdMgr, id, write.SalesStaffInput{Name: "Rina Partial", Active: false, OutletIDs: []string{pBSD, pLWB}}); err != nil {
			t.Fatal(err)
		}
		if got := outletsOf(id); !reflect.DeepEqual(got, []string{pLWB}) {
			t.Fatalf("outlets after Nonaktif = %v", got)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE id=$1 AND active`, id); n != 1 {
			t.Fatal("active must stay true for the LWB side")
		}
		if _, err := rd.SalesStaffByID(ctx, pool, bsdMgr, id); !errors.Is(err, read.ErrNotFound) {
			t.Fatalf("ByID after losing every covered outlet: %v", err)
		}
		after, err := rd.SalesStaffAfterWrite(ctx, pool, bsdMgr, id)
		if err != nil {
			t.Fatalf("AfterWrite must not fail for an entry the caller just edited: %v", err)
		}
		if after.Id.String() != id || after.Name != "Rina Partial" || !after.Active || len(after.OutletIds) != 0 ||
			after.HiddenOutletCount != 1 || after.CanEditDetails || after.User != nil {
			t.Fatalf("AfterWrite shape = %+v", after)
		}
		if _, err := rd.SalesStaffAfterWrite(ctx, pool, bsdMgr, ghost); !errors.Is(err, read.ErrNotFound) {
			t.Fatalf("AfterWrite of a missing id: %v", err)
		}
		if err := update(bsdMgr, id, write.SalesStaffInput{Name: "Rina Partial", Active: true, OutletIDs: []string{pBSD}}); !errors.Is(err, write.ErrSalesStaffNotFound) {
			t.Fatalf("manager without coverage: %v", err)
		}
		id2 := must(create(admin, write.SalesStaffInput{Name: "Rina Keep", Active: true, OutletIDs: []string{pBSD, pLWB}}))
		if err := update(bsdMgr, id2, write.SalesStaffInput{Name: "Rina Keep", Active: true, OutletIDs: []string{}}); err != nil {
			t.Fatal(err)
		}
		if got := outletsOf(id2); !reflect.DeepEqual(got, []string{pLWB}) {
			t.Fatalf("outlets after unticking BSD = %v", got)
		}
	})

	t.Run("duplicate_name", func(t *testing.T) {
		must(create(admin, write.SalesStaffInput{Name: "Dewi Dup", Active: true, OutletIDs: []string{pBSD}}))
		if _, err := create(admin, write.SalesStaffInput{Name: "dewi dup ", Active: true, OutletIDs: []string{pBSD, pMKS}}); !errors.Is(err, write.ErrSalesStaffDuplicateName) {
			t.Fatalf("same outlet duplicate: %v", err)
		}
		must(create(admin, write.SalesStaffInput{Name: "dewi dup", Active: true, OutletIDs: []string{pMKS}}))
		must(create(admin, write.SalesStaffInput{Name: "dewi dup", Active: false, OutletIDs: []string{pBSD}}))
	})

	t.Run("user_link", func(t *testing.T) {
		id := must(create(admin, write.SalesStaffInput{Name: "Link One", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(rBSDCash)}))
		if _, err := create(admin, write.SalesStaffInput{Name: "Link Two", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(rBSDCash)}); !errors.Is(err, write.ErrSalesStaffUserTaken) {
			t.Fatalf("second link: %v", err)
		}
		if s, err := rd.SalesStaffByID(ctx, pool, admin, id); err != nil || s.User == nil || s.User.Id.String() != rBSDCash {
			t.Fatalf("linked user not shown: %v %+v", err, s.User)
		}
		if _, err := create(bsdMgr, write.SalesStaffInput{Name: "Link Out", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(rLWBLink)}); !errors.Is(err, write.ErrSalesStaffForbidden) {
			t.Fatalf("manager linking outside coverage: %v", err)
		}
		if _, err := create(admin, write.SalesStaffInput{Name: "Link Ghost", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(ghost)}); !errors.Is(err, write.ErrSalesStaffInvalid) {
			t.Fatalf("unknown user: %v", err)
		}
		for _, bad := range []string{rLWBCash, ghost} {
			if _, err := create(bsdMgr, write.SalesStaffInput{Name: "Link Probe", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(bad)}); !errors.Is(err, write.ErrSalesStaffForbidden) {
				t.Fatalf("manager linking %s must be Forbidden (same answer for unknown and out-of-coverage): %v", bad, err)
			}
		}
		if _, err := create(bsdMgr, write.SalesStaffInput{Name: "Link Taken", Active: true, OutletIDs: []string{pBSD}, UserID: ptr(rBSDCash)}); !errors.Is(err, write.ErrSalesStaffUserTaken) {
			t.Fatalf("manager linking a linked in-coverage user: %v", err)
		}
		linkable := func(c coverage.Caller) map[string]bool {
			t.Helper()
			lk, err := rd.LinkableUsers(ctx, c)
			if err != nil {
				t.Fatal(err)
			}
			m := map[string]bool{}
			for _, u := range lk {
				m[u.Id.String()] = true
			}
			return m
		}
		mgr := linkable(bsdMgr)
		if !mgr[rBSDMgr] || !mgr[rExtra] {
			t.Fatalf("LinkableUsers(bsdMgr) must contain the unlinked BSD users, got %v", mgr)
		}
		for _, no := range []string{rBSDCash, rLWBLink, rLWBCash} {
			if mgr[no] {
				t.Fatalf("LinkableUsers(bsdMgr) must hide linked and out-of-coverage user %s", no)
			}
		}
		if !linkable(admin)[rLWBLink] {
			t.Fatal("LinkableUsers(admin) must contain the unlinked LWB cashier")
		}
		// A limited caller never links an account that covers every outlet.
		for _, all := range []string{rAdmin, rAll} {
			if mgr[all] {
				t.Fatalf("LinkableUsers(bsdMgr) must hide the all-outlets account %s", all)
			}
			if !linkable(admin)[all] {
				t.Fatalf("LinkableUsers(admin) must contain the all-outlets account %s", all)
			}
			if _, err := create(bsdMgr, write.SalesStaffInput{Name: "Link All " + all[len(all)-3:], Active: true, OutletIDs: []string{pBSD}, UserID: ptr(all)}); !errors.Is(err, write.ErrSalesStaffForbidden) {
				t.Fatalf("limited manager linking all-outlets account %s must be Forbidden: %v", all, err)
			}
		}
	})

	t.Run("version_bump", func(t *testing.T) {
		id := must(create(admin, write.SalesStaffInput{Name: "Version V", Active: true, OutletIDs: []string{pBSD, pLWB}}))
		b0, l0, m0 := version(pBSD), version(pLWB), version(pMKS)
		if err := update(admin, id, write.SalesStaffInput{Name: "Version V", Active: true, OutletIDs: []string{pBSD}}); err != nil {
			t.Fatal(err)
		}
		if version(pBSD) <= b0 || version(pLWB) <= l0 {
			t.Fatal("removing LWB must move the content version of BSD and LWB")
		}
		if version(pMKS) != m0 {
			t.Fatal("an unrelated outlet must not move")
		}
	})

	// HTTP layer: the real handlers behind RequireAuth and the manage_sales_staff gate.
	secret := []byte("SS-SYNTHETIC-TEST-KEY")
	h := New(rd, nil, nil, repo, nil, nil, nil)
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Group(func(r chi.Router) {
		r.Use(mw.RequirePermission("manage_sales_staff"))
		r.Get("/sales-staff", h.ListSalesStaff)
		r.Post("/sales-staff", h.CreateSalesStaff)
		r.Get("/sales-staff/linkable-users", h.ListLinkableSalesStaffUsers)
		r.Put("/sales-staff/{id}", h.UpdateSalesStaff)
	})
	token := func(uid, role, outlet string, perms []string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, uid, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	perm := []string{"manage_sales_staff"}
	adminTok := token(rAdmin, "admin", "", nil)
	mgrTok := token(rBSDMgr, "manager", pBSD, perm)
	cashTok := token(rBSDCash, "cashier", pBSD, nil)
	do := func(tok, method, path, key string, body any) (int, []byte) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&buf).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w.Code, w.Body.Bytes()
	}
	person := func(raw []byte) api.SalesStaff {
		t.Helper()
		var r struct {
			Data api.SalesStaff `json:"data"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatalf("%v: %s", err, raw)
		}
		return r.Data
	}
	mk := func(key, name string, outlets []string) string {
		t.Helper()
		code, body := do(adminTok, "POST", "/sales-staff", key, map[string]any{"name": name, "active": true, "outletIds": outlets})
		if code != http.StatusCreated {
			t.Fatalf("POST %s = %d %s", name, code, body)
		}
		return person(body).Id.String()
	}

	t.Run("http_permissions", func(t *testing.T) {
		someID := "00000000-0000-4000-8f89-0000000009ff"
		in := map[string]any{"name": "Perm Probe", "active": true, "outletIds": []string{pBSD}}
		for _, c := range []struct{ method, path string }{
			{"GET", "/sales-staff"}, {"POST", "/sales-staff"}, {"GET", "/sales-staff/linkable-users"}, {"PUT", "/sales-staff/" + someID},
		} {
			var payload any
			if c.method != "GET" {
				payload = in
			}
			if code, body := do(cashTok, c.method, c.path, "ss-perm-"+c.method, payload); code != http.StatusForbidden {
				t.Fatalf("cashier %s %s = %d %s, want 403", c.method, c.path, code, body)
			}
		}
		for name, tok := range map[string]string{"manager": mgrTok, "admin": adminTok} {
			if code, body := do(tok, "GET", "/sales-staff", "", nil); code != http.StatusOK {
				t.Fatalf("%s list = %d %s", name, code, body)
			}
			if code, body := do(tok, "GET", "/sales-staff/linkable-users", "", nil); code != http.StatusOK {
				t.Fatalf("%s linkable = %d %s", name, code, body)
			}
		}
		if code, _ := do(adminTok, "GET", "/sales-staff?outletId=not-a-uuid", "", nil); code != http.StatusBadRequest {
			t.Fatalf("bad outletId = %d, want 400", code)
		}
		if code, _ := do(adminTok, "GET", "/sales-staff?active=maybe", "", nil); code != http.StatusBadRequest {
			t.Fatalf("bad active = %d, want 400", code)
		}
		if code, body := do(adminTok, "GET", "/sales-staff?q="+strings.Repeat("x", 101), "", nil); code != http.StatusBadRequest || !strings.Contains(string(body), "Pencarian maksimal 100 karakter.") {
			t.Fatalf("overlong q = %d %s, want 400", code, body)
		}
		if code, body := do(adminTok, "GET", "/sales-staff?q="+strings.Repeat("x", 100), "", nil); code != http.StatusOK {
			t.Fatalf("100-char q = %d %s, want 200", code, body)
		}
		if code, body := do(adminTok, "GET", "/sales-staff?active=true&q=zzz-no-such-person", "", nil); code != http.StatusOK || !strings.Contains(string(body), `"data":[]`) {
			t.Fatalf("empty filtered list = %d %s", code, body)
		}
	})

	t.Run("http_release_empty_outlets", func(t *testing.T) {
		id := mk("ss-http-release", "Release Rani", []string{pBSD, pLWB})
		code, body := do(mgrTok, "PUT", "/sales-staff/"+id, "", map[string]any{"name": "Release Rani", "active": false, "outletIds": []string{}, "userId": nil})
		if code != http.StatusOK {
			t.Fatalf("manager release with outletIds [] = %d %s, want 200", code, body)
		}
		if got := person(body); len(got.OutletIds) != 0 || got.HiddenOutletCount != 1 || got.CanEditDetails {
			t.Fatalf("released view = %+v, want no visible outlets, 1 hidden", got)
		}
		code, body = do(adminTok, "GET", "/sales-staff?outletId="+pLWB+"&q=Release+Rani", "", nil)
		if code != http.StatusOK {
			t.Fatalf("admin GET = %d %s", code, body)
		}
		var list struct {
			Data []api.SalesStaff `json:"data"`
		}
		if err := json.Unmarshal(body, &list); err != nil || len(list.Data) != 1 {
			t.Fatalf("admin list = %v %s", err, body)
		}
		if got := list.Data[0]; len(got.OutletIds) != 1 || got.OutletIds[0].String() != pLWB {
			t.Fatalf("admin sees outlets %v, want only LWB", got.OutletIds)
		}
		if got := outletsOf(id); !reflect.DeepEqual(got, []string{pLWB}) {
			t.Fatalf("stored outlets = %v, want LWB only", got)
		}
		// An editor who covers every outlet of the person still must keep one.
		solo := mk("ss-http-solo", "Release Solo", []string{pBSD})
		if code, body := do(mgrTok, "PUT", "/sales-staff/"+solo, "", map[string]any{"name": "Release Solo", "active": true, "outletIds": []string{}}); code != http.StatusBadRequest {
			t.Fatalf("full-cover manager with outletIds [] = %d %s, want 400", code, body)
		}
		if code, body := do(adminTok, "PUT", "/sales-staff/"+solo, "", map[string]any{"name": "Release Solo", "active": true, "outletIds": []string{}}); code != http.StatusBadRequest {
			t.Fatalf("admin with outletIds [] = %d %s, want 400", code, body)
		}
	})

	t.Run("http_create_update", func(t *testing.T) {
		in := map[string]any{"name": "Http Hana", "active": true, "outletIds": []string{pBSD, pLWB}}
		if code, body := do(adminTok, "POST", "/sales-staff", "", in); code != http.StatusBadRequest || !strings.Contains(string(body), "Idempotency-Key wajib") {
			t.Fatalf("POST without key = %d %s", code, body)
		}
		code, first := do(adminTok, "POST", "/sales-staff", "ss-http-key-a", in)
		if code != http.StatusCreated {
			t.Fatalf("POST = %d %s", code, first)
		}
		created := person(first)
		if created.Name != "Http Hana" || len(created.OutletIds) != 2 {
			t.Fatalf("created = %+v", created)
		}
		code, replay := do(adminTok, "POST", "/sales-staff", "ss-http-key-a", in)
		if code != http.StatusCreated || !bytes.Equal(first, replay) {
			t.Fatalf("replay = %d %s, want the first body %s", code, replay, first)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE name='Http Hana'`); n != 1 {
			t.Fatalf("replay created %d rows, want 1", n)
		}
		id := created.Id.String()

		if code, body := do(mgrTok, "PUT", "/sales-staff/"+id, "", map[string]any{"name": "Http Hani", "active": true, "outletIds": []string{pBSD, pLWB}}); code != http.StatusForbidden || !strings.Contains(string(body), "outlet yang Anda kelola") {
			t.Fatalf("partial manager rename = %d %s", code, body)
		}
		if code, body := do(adminTok, "POST", "/sales-staff", "ss-http-key-b", map[string]any{"name": "Http Dup", "active": true, "outletIds": []string{pBSD}}); code != http.StatusCreated {
			t.Fatalf("dup seed = %d %s", code, body)
		}
		if code, body := do(adminTok, "PUT", "/sales-staff/"+id, "", map[string]any{"name": "http dup", "active": true, "outletIds": []string{pBSD}}); code != http.StatusConflict {
			t.Fatalf("duplicate rename = %d %s", code, body)
		}
		if code, _ := do(adminTok, "PUT", "/sales-staff/not-a-uuid", "", in); code != http.StatusBadRequest {
			t.Fatalf("bad path id = %d, want 400", code)
		}
		if code, _ := do(adminTok, "PUT", "/sales-staff/00000000-0000-4000-8f89-0000000009fe", "", in); code != http.StatusNotFound {
			t.Fatalf("unknown id = %d, want 404", code)
		}
		if code, _ := do(adminTok, "POST", "/sales-staff", "ss-http-bad-user", map[string]any{"name": "Http Bad", "active": true, "outletIds": []string{pBSD}, "userId": "not-a-uuid"}); code != http.StatusBadRequest {
			t.Fatalf("non-uuid userId = %d, want 400", code)
		}
		if code, body := do(adminTok, "POST", "/sales-staff", "ss-http-key-c", map[string]any{"name": "Http Null", "active": true, "outletIds": []string{pBSD}, "userId": nil}); code != http.StatusCreated || person(body).User != nil {
			t.Fatalf("userId null = %d %s", code, body)
		}
		if code, body := do(mgrTok, "POST", "/sales-staff", "ss-http-ghost-user", map[string]any{"name": "Http Probe", "active": true, "outletIds": []string{pBSD}, "userId": ghost}); code != http.StatusForbidden {
			t.Fatalf("manager linking unknown user = %d %s, want 403", code, body)
		}
	})

	t.Run("http_partial_manager_deactivate", func(t *testing.T) {
		code, body := do(adminTok, "POST", "/sales-staff", "ss-http-partial", map[string]any{"name": "Http Partial", "active": true, "outletIds": []string{pBSD, pLWB}})
		if code != http.StatusCreated {
			t.Fatalf("POST = %d %s", code, body)
		}
		id := person(body).Id.String()
		code, body = do(mgrTok, "PUT", "/sales-staff/"+id, "", map[string]any{"name": "Http Partial", "active": false, "outletIds": []string{pBSD, pLWB}})
		if code != http.StatusOK {
			t.Fatalf("manager Nonaktif = %d %s", code, body)
		}
		if got := person(body); len(got.OutletIds) != 0 || got.HiddenOutletCount != 1 {
			t.Fatalf("reduced shape = %+v", got)
		}
		code, body = do(adminTok, "GET", "/sales-staff?outletId="+pLWB+"&q=Http+Partial", "", nil)
		var list struct {
			Data []api.SalesStaff `json:"data"`
		}
		if err := json.Unmarshal(body, &list); err != nil || code != http.StatusOK {
			t.Fatalf("admin list = %d %v %s", code, err, body)
		}
		s := find(list.Data, id)
		if s == nil || !s.Active || len(s.OutletIds) != 1 || s.OutletIds[0].String() != pLWB {
			t.Fatalf("admin view after partial Nonaktif = %+v", s)
		}
	})

	t.Run("http_cashier_with_permission", func(t *testing.T) {
		// A cashier granted manage_sales_staff (custom role) sees only people at the home outlet.
		cashPerm := token(rBSDCash, "cashier", pBSD, perm)
		both := mk("ss-http-cp-both", "Http CP Both", []string{pBSD, pLWB})
		lwbOnly := mk("ss-http-cp-lwb", "Http CP LWB", []string{pLWB})
		code, body := do(cashPerm, "GET", "/sales-staff", "", nil)
		var list struct {
			Data []api.SalesStaff `json:"data"`
		}
		if err := json.Unmarshal(body, &list); err != nil || code != http.StatusOK {
			t.Fatalf("list = %d %v %s", code, err, body)
		}
		if find(list.Data, lwbOnly) != nil {
			t.Fatal("cashier must not see a person who works only at another outlet")
		}
		if s := find(list.Data, both); s == nil || s.HiddenOutletCount != 1 || len(s.OutletIds) != 1 || s.OutletIds[0].String() != pBSD {
			t.Fatalf("cashier view of BSD+LWB person = %+v", s)
		}
		for _, s := range list.Data {
			for _, o := range s.OutletIds {
				if o.String() != pBSD {
					t.Fatalf("cashier sees outlet %s of %s", o, s.Name)
				}
			}
		}
	})

	t.Run("http_key_reuse_other_body", func(t *testing.T) {
		in := map[string]any{"name": "Http Reuse A", "active": true, "outletIds": []string{pBSD}}
		if code, body := do(adminTok, "POST", "/sales-staff", "ss-http-reuse", in); code != http.StatusCreated {
			t.Fatalf("first POST = %d %s", code, body)
		}
		in["name"] = "Http Reuse B"
		if code, body := do(adminTok, "POST", "/sales-staff", "ss-http-reuse", in); code != http.StatusConflict {
			t.Fatalf("same key, other body = %d %s, want 409", code, body)
		}
		if n := count(`SELECT count(*) FROM sales_staff WHERE name='Http Reuse B'`); n != 0 {
			t.Fatal("the conflicting body must not be applied")
		}
	})

	t.Run("http_uncovered_outlet_filter", func(t *testing.T) {
		// A manager gets the same answer for an outlet they do not cover and one that does not exist.
		c1, b1 := do(mgrTok, "GET", "/sales-staff?outletId="+pLWB, "", nil)
		c2, b2 := do(mgrTok, "GET", "/sales-staff?outletId=00000000-0000-4000-8f89-0000000009fd", "", nil)
		if c1 != http.StatusForbidden || c2 != http.StatusForbidden || !bytes.Equal(b1, b2) {
			t.Fatalf("uncovered = %d %s, nonexistent = %d %s", c1, b1, c2, b2)
		}
	})

	t.Run("http_id_case", func(t *testing.T) {
		id := mk("ss-http-case", "Http Case", []string{pBSD})
		code, body := do(adminTok, "PUT", "/sales-staff/"+strings.ToUpper(id), "", map[string]any{"name": "Http Case", "active": true, "outletIds": []string{pBSD}})
		if code != http.StatusOK {
			t.Fatalf("PUT with upper-case id = %d %s, want 200", code, body)
		}
	})

	t.Run("pull_lists", func(t *testing.T) {
		must(create(admin, write.SalesStaffInput{Name: "zed pull", Active: true, OutletIDs: []string{pBSD}}))
		must(create(admin, write.SalesStaffInput{Name: "Abe Pull", Active: true, OutletIDs: []string{pBSD}}))
		must(create(admin, write.SalesStaffInput{Name: "Off Pull", Active: false, OutletIDs: []string{pBSD}}))
		must(create(admin, write.SalesStaffInput{Name: "Elsewhere Pull", Active: true, OutletIDs: []string{pLWB}}))
		picks, err := rd.SalesStaffForOutlet(ctx, pBSD)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, p := range picks {
			if strings.HasSuffix(p.Name, " Pull") || strings.HasSuffix(p.Name, " pull") {
				names = append(names, p.Name)
			}
		}
		if !reflect.DeepEqual(names, []string{"Abe Pull", "zed pull"}) {
			t.Fatalf("picks = %v", names)
		}
		users, err := rd.UsersForOutlet(ctx, pBSD)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]bool{}
		for _, u := range users {
			got[u.Id.String()] = true
		}
		for _, want := range []string{rAdmin, rAll, rBSDCash, rExtra, rBSDMgr} {
			if !got[want] {
				t.Fatalf("UsersForOutlet(BSD) misses %s", want)
			}
		}
		for _, no := range []string{rLWBCash, rNoHome} {
			if got[no] {
				t.Fatalf("UsersForOutlet(BSD) must exclude %s", no)
			}
		}
	})

	t.Run("sales_performance_link", func(t *testing.T) {
		const (
			plOut  = "00000000-0000-4000-8f89-000000000301"
			plUser = "00000000-0000-4000-8f89-000000000302"
			plCash = "00000000-0000-4000-8f89-000000000303"
		)
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'PL outlet','pl-out','PLO')`, plOut)
		for _, u := range []struct{ id, role, name string }{{plUser, "cashier", "PL linked user"}, {plCash, "cashier", "PL cashier"}} {
			exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,$5)`,
				u.id, u.id+"@example.invalid", u.name, u.role, plOut)
		}
		staff := must(create(admin, write.SalesStaffInput{Name: "Rina Link", Active: true, OutletIDs: []string{plOut}, UserID: ptr(plUser)}))
		orders := []struct {
			id, num, salesman, name string
			total                   int
		}{
			{"00000000-0000-4000-8f89-000000000311", "PL-1", plUser, "Old", 100000},
			{"00000000-0000-4000-8f89-000000000312", "PL-2", plUser, "Old", 200000},
			{"00000000-0000-4000-8f89-000000000313", "PL-3", staff, "Rina Link", 150000},
			{"00000000-0000-4000-8f89-000000000314", "PL-4", "", "", 80000},
		}
		for _, o := range orders {
			exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,salesman_id,salesman_name,
			        subtotal,discount_amount,total,payment_method,status,created_at)
			      VALUES($1,$1,$2,$2,$3,$4,'PL cashier',NULLIF($5,'')::uuid,NULLIF($6,''),$7::numeric,0,$7::numeric,'cash','completed','2026-11-10T03:00:00Z')`,
				o.id, o.num, plOut, plCash, o.salesman, o.name, o.total)
		}
		// A partial refund of an OLD user-id order, on another business day: it must reduce the grouped row.
		exec(`INSERT INTO order_refunds(order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
		      VALUES($1,$2,1,'partial',40000,40000,'cash','PL','pl-rf-1','2026-11-11T03:00:00Z','2026-11-11')`, orders[0].id, plOut)
		for i, o := range orders[:3] {
			if i == 1 {
				continue // order 2 stays unrated
			}
			exec(`INSERT INTO order_ratings(order_id,outlet_id,salesman_id,salesman_name,business_date,stars,comment)
			      VALUES($1,$2,NULLIF($3,'')::uuid,$4,'2026-11-10',$5,$6)`, o.id, plOut, o.salesman, o.name, 5-i, "komentar "+o.num)
		}

		f := read.OrderFilter{Scope: read.Scope{OutletID: plOut}, DateFrom: "2026-11-10", DateTo: "2026-11-11"}
		report := func() map[string]api.SalesPerformanceRow {
			t.Helper()
			rep, err := rd.SalesPerformance(ctx, f)
			if err != nil {
				t.Fatal(err)
			}
			m := map[string]api.SalesPerformanceRow{}
			for _, r := range rep.Data {
				k := "none"
				if r.SalesmanId != nil {
					k = r.SalesmanId.String()
				}
				m[k] = r
			}
			if len(m) != len(rep.Data) {
				t.Fatalf("duplicate keys in %+v", rep.Data)
			}
			return m
		}
		ratingOrders := func(salesman string) []string {
			t.Helper()
			rs, total, err := rd.SalesRatings(ctx, f, salesman, false, 1, 50)
			if err != nil {
				t.Fatal(err)
			}
			if total != len(rs) {
				t.Fatalf("SalesRatings(%s) total %d vs %d rows", salesman, total, len(rs))
			}
			var nums []string
			for _, r := range rs {
				nums = append(nums, r.OrderNumber)
			}
			sort.Strings(nums)
			return nums
		}

		// Linked: old user-id picks and the staff entry's picks are one row under the staff id and name.
		m := report()
		if len(m) != 2 {
			t.Fatalf("linked rows = %+v", m)
		}
		row, ok := m[staff]
		if !ok || row.SalesmanName != "Rina Link" || row.Transactions != 3 || row.Revenue != 410000 || row.RatingsReceived != 2 {
			t.Fatalf("grouped row = %+v (ok=%v), want key staff, Rina Link, 3 txns, revenue 410000 (refund joined), 2 ratings", row, ok)
		}
		if _, leaked := m[plUser]; leaked {
			t.Fatal("the linked user id must not be a separate row")
		}
		if none := m["none"]; none.SalesmanName != "Tanpa sales" || none.Transactions != 1 || none.Revenue != 80000 {
			t.Fatalf("none row = %+v", none)
		}
		if got := ratingOrders(staff); !reflect.DeepEqual(got, []string{"PL-1", "PL-3"}) {
			t.Fatalf("SalesRatings(staff) = %v", got)
		}
		if got := ratingOrders(plUser); len(got) != 0 {
			t.Fatalf("SalesRatings(user id) after linking = %v, want none (grouped under the staff id)", got)
		}
		if got := ratingOrders("none"); len(got) != 0 {
			t.Fatalf("SalesRatings(none) = %v", got)
		}
		if rs, _, err := rd.SalesRatings(ctx, f, staff, false, 1, 50); err != nil || len(rs) == 0 || rs[0].SalesmanId == nil || rs[0].SalesmanId.String() != staff || rs[0].SalesmanName != "Rina Link" {
			t.Fatalf("rating row key/name = %+v %v", rs, err)
		}
		if rs, _, err := rd.SalesRatings(ctx, f, staff, false, 2, 50); err != nil || len(rs) != 0 {
			t.Fatalf("past-the-end page = %+v %v", rs, err)
		}

		// Unlinked: two rows again, the user id with its old name and the staff entry with its own picks.
		exec(`UPDATE sales_staff SET user_id = NULL WHERE id = $1`, staff)
		m = report()
		if len(m) != 3 {
			t.Fatalf("unlinked rows = %+v", m)
		}
		if r := m[plUser]; r.SalesmanName != "Old" || r.Transactions != 2 || r.Revenue != 260000 {
			t.Fatalf("user row = %+v", r)
		}
		if r := m[staff]; r.SalesmanName != "Rina Link" || r.Transactions != 1 || r.Revenue != 150000 {
			t.Fatalf("staff row = %+v", r)
		}
		if got := ratingOrders(plUser); !reflect.DeepEqual(got, []string{"PL-1"}) {
			t.Fatalf("SalesRatings(user) after unlink = %v", got)
		}
		if got := ratingOrders(staff); !reflect.DeepEqual(got, []string{"PL-3"}) {
			t.Fatalf("SalesRatings(staff) after unlink = %v", got)
		}
	})

	t.Run("pull_bundle", func(t *testing.T) {
		const (
			pbA  = "00000000-0000-4000-8f89-000000000221"
			pbB  = "00000000-0000-4000-8f89-000000000222"
			pbEm = "00000000-0000-4000-8f89-000000000223"
			ubA  = "00000000-0000-4000-8f89-0000000000c1"
		)
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'PB A','pb-a','PBA'),($2,'PB B','pb-b','PBB'),($3,'PB Empty','pb-e','PBE')`, pbA, pbB, pbEm)
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'pb-a@example.test','x','PB A cashier','cashier',$2)`, ubA, pbA)
		must(create(admin, write.SalesStaffInput{Name: "Pull B Active", Active: true, OutletIDs: []string{pbA}}))
		must(create(admin, write.SalesStaffInput{Name: "Pull B Off", Active: false, OutletIDs: []string{pbA}}))
		must(create(admin, write.SalesStaffInput{Name: "Pull B Other", Active: true, OutletIDs: []string{pbB}}))
		eng := syncpkg.New(pool, rd, nil, repo)
		pull := func(outlet string) map[string]json.RawMessage {
			t.Helper()
			b, err := eng.Pull(ctx, read.Scope{OutletID: outlet}, outlet)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(b)
			var m map[string]json.RawMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			return m
		}
		keysOf := func(raw json.RawMessage) (rows []map[string]json.RawMessage) {
			t.Helper()
			if err := json.Unmarshal(raw, &rows); err != nil {
				t.Fatalf("%v: %s", err, raw)
			}
			return rows
		}
		sortedKeys := func(m map[string]json.RawMessage) (k []string) {
			for key := range m {
				k = append(k, key)
			}
			sort.Strings(k)
			return
		}

		a := pull(pbA)
		staff := keysOf(a["salesStaff"])
		if len(staff) != 1 {
			t.Fatalf("salesStaff = %s, want only the active entry linked to the outlet", a["salesStaff"])
		}
		if k := sortedKeys(staff[0]); !reflect.DeepEqual(k, []string{"id", "name"}) {
			t.Fatalf("salesStaff keys = %v", k)
		}
		if string(staff[0]["name"]) != `"Pull B Active"` {
			t.Fatalf("salesStaff name = %s", staff[0]["name"])
		}
		users := keysOf(a["users"])
		if len(users) == 0 {
			t.Fatal("users empty for the outlet")
		}
		sawCashier := false
		for _, u := range users {
			if k := sortedKeys(u); !reflect.DeepEqual(k, []string{"displayName", "id"}) {
				t.Fatalf("users keys = %v", k)
			}
			if string(u["id"]) == `"`+ubA+`"` {
				sawCashier = true
			}
		}
		if !sawCashier {
			t.Fatalf("users misses the outlet's cashier: %s", a["users"])
		}
		for _, banned := range []string{"email", "role", "permissions", "outletIds"} {
			if strings.Contains(string(a["users"]), `"`+banned+`"`) {
				t.Fatalf("users carries %q: %s", banned, a["users"])
			}
		}

		// An outlet with no sales staff and no covering cashier still ships arrays, not null.
		e := pull(pbEm)
		if string(e["salesStaff"]) != "[]" {
			t.Fatalf("empty outlet salesStaff = %s, want []", e["salesStaff"])
		}
		if string(e["users"]) == "null" {
			t.Fatalf("users must be an array, got null")
		}
		// Admin/all-scope users cover every outlet, so users is not empty here; force the
		// empty-array case through the repo as well.
		if got, err := rd.UsersForOutlet(ctx, "00000000-0000-4000-8f89-0000000000ff"); err != nil || got == nil {
			t.Fatalf("UsersForOutlet(unknown) = %v, %v; want non-nil", got, err)
		}
	})
}

func ptr(s string) *string { return &s }
