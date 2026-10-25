package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// Permintaan Barang (PB): the outlet raises it, the warehouse approves per line and fulfils it
// into ONE gudang -> toko transfer draft. Everything speaks raw JSON over HTTP through the real
// auth middleware and the same permission groups as server.go. Opt-in only, same isolation
// contract as the other PostgreSQL gates.
func TestRequisitionPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_RQ_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56474 || cfg.ConnConfig.Database != "mandalika_rq_synthetic" || cfg.ConnConfig.User != "rq_test" {
		t.Fatal("refusing non-fixture target")
	}
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
	expected := os.Getenv("MANDALIKA_RQ_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	f := newRqFixture(t, ctx, pool)
	f.run(t)
}

const (
	rqOutletA   = "00000000-0000-4000-8f00-000000000001"
	rqOutletB   = "00000000-0000-4000-8f00-000000000002"
	rqStaffA    = "00000000-0000-4000-8f00-000000000011"
	rqStaffB    = "00000000-0000-4000-8f00-000000000012"
	rqWarehouse = "00000000-0000-4000-8f00-000000000021"
	rqWhOff     = "00000000-0000-4000-8f00-000000000022"
	rqWhUser    = "00000000-0000-4000-8f00-000000000031"
	rqAdmin     = "00000000-0000-4000-8f00-000000000032"
)

type rqFixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	repo   *write.Repo
	router http.Handler
	tokens map[string]string // staffA, staffB, wh, admin
	seq    int
}

func newRqFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *rqFixture {
	f := &rqFixture{ctx: ctx, pool: pool, tokens: map[string]string{}}
	f.exec(t, `INSERT INTO outlets(id,name) VALUES($1,'RQ outlet A'),($2,'RQ outlet B')`, rqOutletA, rqOutletB)
	f.exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'RQ gudang')`, rqWarehouse)
	f.exec(t, `INSERT INTO warehouses(id,name,is_active) VALUES($1,'RQ gudang nonaktif',false)`, rqWhOff)
	for _, u := range []struct{ id, name, role, outlet string }{
		{rqStaffA, "Staf A", "cashier", rqOutletA}, {rqStaffB, "Staf B", "cashier", rqOutletB},
		{rqWhUser, "Gudang", "cashier", ""}, {rqAdmin, "Admin", "admin", ""},
	} {
		if u.outlet == "" {
			f.exec(t, `INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,$2,'x',$3,$4)`, u.id, u.name+"@example.invalid", u.name, u.role)
		} else {
			f.exec(t, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,$5)`, u.id, u.name+"@example.invalid", u.name, u.role, u.outlet)
		}
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	f.repo = wr
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("RQ-INTEGRATION-SYNTHETIC-KEY")
	issue := func(name, uid, role, outlet string, perms ...string) {
		tok, err := auth.IssueAccess(secret, time.Hour, uid, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		f.tokens[name] = tok
	}
	issue("staffA", rqStaffA, "cashier", rqOutletA, "request_stock")
	issue("staffB", rqStaffB, "cashier", rqOutletB, "request_stock")
	issue("wh", rqWhUser, "cashier", "", "manage_inventory")
	issue("admin", rqAdmin, "admin", "")

	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	r := chi.NewRouter()
	r.With(authWrap).Get("/requisitions", h.Requisitions)
	r.With(authWrap).Get("/requisitions/{id}", h.Requisition)
	r.Group(func(r chi.Router) {
		r.Use(authWrap, mw.RequirePermission("request_stock"))
		r.Post("/requisitions", h.CreateRequisition)
		r.Put("/requisitions/{id}", h.UpdateRequisition)
		r.Post("/requisitions/{id}/submit", h.SubmitRequisition)
		r.Post("/requisitions/{id}/cancel", h.CancelRequisition)
	})
	r.Group(func(r chi.Router) {
		r.Use(authWrap, mw.RequirePermission("manage_inventory"))
		r.Post("/requisitions/{id}/approve", h.ApproveRequisition)
		r.Post("/requisitions/{id}/reject", h.RejectRequisition)
		r.Post("/requisitions/{id}/fulfil", h.FulfilRequisition)
	})
	r.With(authWrap).Delete("/products/{id}", h.DeleteProduct)
	r.With(authWrap).Delete("/warehouses/{id}", h.DeleteWarehouse)
	f.router = r
	return f
}

func (f *rqFixture) exec(t testing.TB, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}

func (f *rqFixture) count(t testing.TB, sql string, args ...any) (n int) {
	t.Helper()
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func (f *rqFixture) str(t testing.TB, sql string, args ...any) (s string) {
	t.Helper()
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&s); err != nil {
		t.Fatalf("str: %v", err)
	}
	return s
}

func (f *rqFixture) product(t testing.TB) string {
	t.Helper()
	f.seq++
	id := fmt.Sprintf("00000000-0000-4000-8f10-%012d", f.seq)
	f.exec(t, `INSERT INTO products(id,name) VALUES($1,$2)`, id, "RQ product "+id)
	f.exec(t, `INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'M',1000,0,$2)`, id, fmt.Sprintf("RQ%d", f.seq))
	return id
}

// call sends one request as the named user; hdr adds extra headers; key "" sends none.
func (f *rqFixture) call(who, method, path string, body any, key string, hdr ...string) (int, string) {
	rdr := strings.NewReader("")
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = strings.NewReader(string(raw))
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", "Bearer "+f.tokens[who])
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func (f *rqFixture) key() string { f.seq++; return fmt.Sprintf("rq-key-%d", f.seq) }

func (f *rqFixture) want(t *testing.T, got int, body string, want int, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: status %d, want %d (%s)", what, got, want, body)
	}
}

func rqLines(items ...map[string]any) map[string]any { return map[string]any{"items": items} }

func rqLine(pid string, qty int) map[string]any {
	return map[string]any{"productId": pid, "variantSize": "M", "requestedQty": qty}
}

type rqPB struct {
	Data struct {
		ID       string `json:"id"`
		Number   string `json:"number"`
		Status   string `json:"status"`
		OutletID string `json:"outletId"`
		Transfer *struct {
			ID, TransferNo, Status string
		} `json:"transfer"`
		Items []struct {
			ID           string `json:"id"`
			TransferQty  *int   `json:"transferQty"`
			ProductID    string `json:"productId"`
			RequestedQty int    `json:"requestedQty"`
			ApprovedQty  *int   `json:"approvedQty"`
		} `json:"items"`
		Events []struct {
			Action string         `json:"action"`
			Data   map[string]any `json:"data"`
		} `json:"events"`
	} `json:"data"`
}

func (f *rqFixture) decode(t *testing.T, body string) rqPB {
	t.Helper()
	var v rqPB
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return v
}

// create makes a draft as staff A with the given product lines and returns its id.
func (f *rqFixture) create(t *testing.T, who string, items ...map[string]any) string {
	t.Helper()
	code, body := f.call(who, "POST", "/requisitions", rqLines(items...), f.key())
	f.want(t, code, body, 201, "create")
	return f.decode(t, body).Data.ID
}

func (f *rqFixture) get(t *testing.T, who, id string) rqPB {
	t.Helper()
	code, body := f.call(who, "GET", "/requisitions/"+id, nil, "")
	f.want(t, code, body, 200, "get")
	return f.decode(t, body)
}

func (f *rqFixture) submit(t *testing.T, id string) {
	t.Helper()
	code, body := f.call("staffA", "POST", "/requisitions/"+id+"/submit", nil, f.key())
	f.want(t, code, body, 200, "submit")
}

func (f *rqFixture) approve(t *testing.T, id string, qty ...int) (int, string) {
	t.Helper()
	pb := f.get(t, "wh", id)
	var items []map[string]any
	for i, it := range pb.Data.Items {
		items = append(items, map[string]any{"itemId": it.ID, "approvedQty": qty[i]})
	}
	return f.call("wh", "POST", "/requisitions/"+id+"/approve",
		map[string]any{"warehouseId": rqWarehouse, "items": items, "note": "ok"}, f.key())
}

func (f *rqFixture) run(t *testing.T) {
	t.Run("missing-idempotency-key-is-400", f.missingKey)
	t.Run("create-and-visibility", f.createAndVisibility)
	t.Run("outlet-scope-and-spoofing", f.outletScope)
	t.Run("validation", f.validation)
	t.Run("state-machine", f.stateMachine)
	t.Run("approve-rules", f.approveRules)
	t.Run("reject", f.reject)
	t.Run("fulfil-and-refulfil", f.fulfil)
	t.Run("fulfil-concurrent", f.fulfilConcurrent)
	t.Run("transfer-qty", f.transferQty)
	t.Run("delete-guards-and-inactive-warehouse", f.deletesAndInactive)
	t.Run("four-eyes", f.fourEyes)
	t.Run("history", f.history)
}

func (f *rqFixture) missingKey(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 1))
	for _, c := range []struct {
		who, method, path string
		body              any
	}{
		{"staffA", "POST", "/requisitions", rqLines(rqLine(p, 1))},
		{"staffA", "PUT", "/requisitions/" + id, rqLines(rqLine(p, 2))},
		{"staffA", "POST", "/requisitions/" + id + "/submit", nil},
		{"staffA", "POST", "/requisitions/" + id + "/cancel", nil},
		{"wh", "POST", "/requisitions/" + id + "/approve", map[string]any{"warehouseId": rqWarehouse, "items": []any{}}},
		{"wh", "POST", "/requisitions/" + id + "/reject", map[string]any{"note": "x"}},
		{"wh", "POST", "/requisitions/" + id + "/fulfil", nil},
	} {
		code, body := f.call(c.who, c.method, c.path, c.body, "")
		f.want(t, code, body, 400, "no key: "+c.method+" "+c.path)
		code, body = f.call(c.who, c.method, c.path, c.body, "   ")
		f.want(t, code, body, 400, "blank key: "+c.method+" "+c.path)
	}
	if got := f.get(t, "staffA", id).Data.Status; got != "draft" {
		t.Fatalf("a keyless write changed the PB to %s", got)
	}
}

func (f *rqFixture) createAndVisibility(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 3))
	pb := f.get(t, "staffA", id)
	year := time.Now().Year()
	if !strings.HasPrefix(pb.Data.Number, fmt.Sprintf("PB-%d-", year)) || len(pb.Data.Number) != len("PB-2026-00001") {
		t.Errorf("number %q is not PB-YYYY-NNNNN", pb.Data.Number)
	}
	if pb.Data.Status != "draft" || pb.Data.OutletID != rqOutletA {
		t.Errorf("created PB: %+v", pb.Data)
	}
	// Another outlet's draft is a 404, and the warehouse cannot see a draft either.
	for _, who := range []string{"staffB", "wh"} {
		code, body := f.call(who, "GET", "/requisitions/"+id, nil, "")
		f.want(t, code, body, 404, who+" reads another outlet's draft")
		code, body = f.call(who, "GET", "/requisitions", nil, "")
		f.want(t, code, body, 200, who+" list")
		if strings.Contains(body, id) {
			t.Errorf("%s list leaks another outlet's draft", who)
		}
	}
	// A draft cancelled before submit stays private to its outlet.
	cd := f.create(t, "staffA", rqLine(p, 1))
	code, body := f.call("staffA", "POST", "/requisitions/"+cd+"/cancel", nil, f.key())
	f.want(t, code, body, 200, "cancel draft")
	code, body = f.call("wh", "GET", "/requisitions/"+cd, nil, "")
	f.want(t, code, body, 404, "wh reads a draft-cancelled PB")
	code, body = f.call("wh", "GET", "/requisitions", nil, "")
	if strings.Contains(body, cd) {
		t.Errorf("wh list leaks a draft-cancelled PB")
	}
	f.submit(t, id)
	code, body = f.call("wh", "GET", "/requisitions?status=submitted", nil, "")
	f.want(t, code, body, 200, "wh list")
	if !strings.Contains(body, id) {
		t.Errorf("the warehouse list lacks the submitted PB")
	}
	code, body = f.call("staffB", "GET", "/requisitions", nil, "")
	if strings.Contains(body, id) {
		t.Errorf("outlet B list leaks outlet A's submitted PB")
	}
	code, body = f.call("staffA", "GET", "/requisitions?status=bogus", nil, "")
	f.want(t, code, body, 400, "bad status filter")
	// A caller holding neither permission gets 403 on reads.
	f.tokens["none"], _ = auth.IssueAccess([]byte("RQ-INTEGRATION-SYNTHETIC-KEY"), time.Hour, rqStaffA, "cashier", rqOutletA, []string{"create_order"})
	code, body = f.call("none", "GET", "/requisitions", nil, "")
	f.want(t, code, body, 403, "no permission list")
	// The warehouse is refused the outlet-side writes, the outlet the warehouse-side ones.
	code, body = f.call("wh", "POST", "/requisitions", rqLines(rqLine(p, 1)), f.key())
	f.want(t, code, body, 403, "wh create")
	code, body = f.call("staffA", "POST", "/requisitions/"+id+"/approve", map[string]any{"warehouseId": rqWarehouse}, f.key())
	f.want(t, code, body, 403, "staff approve")
	code, body = f.call("staffA", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 403, "staff fulfil")
}

func (f *rqFixture) outletScope(t *testing.T) {
	p := f.product(t)
	// Outlet comes from the authenticated scope: a body field and a ?outletId query are ignored.
	raw := map[string]any{"outletId": rqOutletB, "items": []any{rqLine(p, 1)}}
	code, body := f.call("staffA", "POST", "/requisitions?outletId="+rqOutletB, raw, f.key())
	f.want(t, code, body, 201, "create with spoofed body/query")
	if got := f.decode(t, body).Data.OutletID; got != rqOutletA {
		t.Fatalf("PB went to outlet %s, want the caller's A", got)
	}
	// A raw X-Outlet-Id for another outlet is refused by the auth middleware.
	code, body = f.call("staffA", "POST", "/requisitions", rqLines(rqLine(p, 1)), f.key(), "X-Outlet-Id", rqOutletB)
	f.want(t, code, body, 403, "header spoof")
	// An admin has no outlet unless they name one (validated header).
	code, body = f.call("admin", "POST", "/requisitions", rqLines(rqLine(p, 1)), f.key())
	f.want(t, code, body, 400, "admin without outlet")
	code, body = f.call("admin", "POST", "/requisitions", rqLines(rqLine(p, 1)), f.key(), "X-Outlet-Id", rqOutletB)
	f.want(t, code, body, 201, "admin with outlet header")
	if got := f.decode(t, body).Data.OutletID; got != rqOutletB {
		t.Fatalf("admin PB went to %s, want B", got)
	}
	// Outlet B cannot edit, submit or cancel outlet A's PB: 404, nothing changes.
	id := f.create(t, "staffA", rqLine(p, 1))
	for _, c := range []struct{ method, path string }{
		{"PUT", "/requisitions/" + id}, {"POST", "/requisitions/" + id + "/submit"}, {"POST", "/requisitions/" + id + "/cancel"},
	} {
		code, body := f.call("staffB", c.method, c.path, rqLines(rqLine(p, 9)), f.key())
		f.want(t, code, body, 404, "other outlet "+c.method+" "+c.path)
	}
	if got := f.get(t, "staffA", id); got.Data.Status != "draft" || got.Data.Items[0].RequestedQty != 1 {
		t.Fatalf("another outlet changed the PB: %+v", got.Data)
	}
	// The warehouse cannot approve/reject/fulfil another outlet's draft either (404, not a leak).
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/reject", map[string]any{"note": "x"}, f.key())
	f.want(t, code, body, 404, "wh reject a draft")
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 404, "wh fulfil a draft")
}

func (f *rqFixture) validation(t *testing.T) {
	p, q := f.product(t), f.product(t)
	cases := []struct {
		name string
		body any
	}{
		{"no lines", rqLines()},
		{"zero qty", rqLines(rqLine(p, 0))},
		{"duplicate (product,size)", rqLines(rqLine(p, 1), rqLine(p, 2))},
		{"bad product id", rqLines(rqLine("nope", 1))},
		{"bad date", map[string]any{"neededBy": "soon", "items": []any{rqLine(p, 1)}}},
	}
	for _, c := range cases {
		code, body := f.call("staffA", "POST", "/requisitions", c.body, f.key())
		f.want(t, code, body, 400, "create "+c.name)
	}
	id := f.create(t, "staffA", rqLine(p, 1), rqLine(q, 1))
	code, body := f.call("staffA", "PUT", "/requisitions/"+id, rqLines(rqLine(p, 1), rqLine(p, 2)), f.key())
	f.want(t, code, body, 400, "update with a duplicate line")
	if n := len(f.get(t, "staffA", id).Data.Items); n != 2 {
		t.Fatalf("a refused update changed the lines: %d left", n)
	}
	code, body = f.call("staffA", "PUT", "/requisitions/"+id, map[string]any{"note": "baru", "neededBy": "2026-11-03",
		"items": []any{rqLine(p, 4)}}, f.key())
	f.want(t, code, body, 200, "update draft")
	if pb := f.get(t, "staffA", id); len(pb.Data.Items) != 1 || pb.Data.Items[0].RequestedQty != 4 {
		t.Fatalf("update not applied: %+v", pb.Data.Items)
	}
}

func (f *rqFixture) stateMachine(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 2))
	post := func(who, action string, body any) (int, string) {
		return f.call(who, "POST", "/requisitions/"+id+"/"+action, body, f.key())
	}
	// draft: cannot approve / reject / fulfil as the warehouse sees no draft (404, covered above);
	// the outlet cannot cancel twice or submit twice.
	f.submit(t, id)
	code, body := post("staffA", "submit", nil)
	f.want(t, code, body, 409, "submit twice")
	code, body = f.call("staffA", "PUT", "/requisitions/"+id, rqLines(rqLine(p, 9)), f.key())
	f.want(t, code, body, 409, "edit a submitted PB")
	code, body = post("wh", "fulfil", nil)
	f.want(t, code, body, 409, "fulfil before approval")
	code, body = post("staffA", "cancel", nil)
	f.want(t, code, body, 200, "cancel submitted")
	for _, c := range []struct {
		who, action string
		body        any
	}{
		{"staffA", "cancel", nil}, {"staffA", "submit", nil},
		{"wh", "approve", map[string]any{"warehouseId": rqWarehouse, "items": []any{}}},
		{"wh", "reject", map[string]any{"note": "x"}}, {"wh", "fulfil", nil},
	} {
		code, body := post(c.who, c.action, c.body)
		f.want(t, code, body, 409, "cancelled PB "+c.action)
	}
	if f.get(t, "staffA", id).Data.Status != "cancelled" {
		t.Fatal("cancelled PB changed status")
	}
	// A cancelled draft too; an approved PB can no longer be cancelled or rejected.
	d := f.create(t, "staffA", rqLine(p, 1))
	code, body = f.call("staffA", "POST", "/requisitions/"+d+"/cancel", nil, f.key())
	f.want(t, code, body, 200, "cancel draft")
	a := f.create(t, "staffA", rqLine(p, 1))
	f.submit(t, a)
	code, body = f.approve(t, a, 1)
	f.want(t, code, body, 200, "approve")
	for _, act := range []string{"cancel", "submit"} {
		code, body = f.call("staffA", "POST", "/requisitions/"+a+"/"+act, nil, f.key())
		f.want(t, code, body, 409, "approved PB "+act)
	}
	code, body = f.call("wh", "POST", "/requisitions/"+a+"/reject", map[string]any{"note": "x"}, f.key())
	f.want(t, code, body, 409, "reject an approved PB")
	code, body = f.approve(t, a, 1)
	f.want(t, code, body, 409, "approve twice")
}

func (f *rqFixture) approveRules(t *testing.T) {
	p, q := f.product(t), f.product(t)
	id := f.create(t, "staffA", rqLine(p, 5), rqLine(q, 3))
	f.submit(t, id)
	code, body := f.approve(t, id, 6, 3)
	f.want(t, code, body, 400, "approvedQty above requestedQty")
	code, body = f.approve(t, id, -1, 3)
	f.want(t, code, body, 400, "negative approvedQty")
	pb := f.get(t, "wh", id)
	two := []map[string]any{{"itemId": pb.Data.Items[0].ID, "approvedQty": 1}}
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/approve", map[string]any{"warehouseId": rqWarehouse, "items": two}, f.key())
	f.want(t, code, body, 400, "a line without a decision")
	full := []map[string]any{{"itemId": pb.Data.Items[0].ID, "approvedQty": 1}, {"itemId": pb.Data.Items[1].ID, "approvedQty": 1}}
	for _, wid := range []string{"", rqWhOff, "00000000-0000-4000-8f00-0000000000ff"} {
		code, body = f.call("wh", "POST", "/requisitions/"+id+"/approve", map[string]any{"warehouseId": wid, "items": full}, f.key())
		if code != 400 {
			t.Errorf("warehouse %q: status %d, want 400 (%s)", wid, code, body)
		}
	}
	if st := f.get(t, "wh", id).Data.Status; st != "submitted" {
		t.Fatalf("refused approvals changed the PB to %s", st)
	}
	code, body = f.approve(t, id, 2, 0) // partial, one line zero
	f.want(t, code, body, 200, "valid partial approval")
	got := f.decode(t, body)
	if got.Data.Status != "approved" || *got.Data.Items[0].ApprovedQty+*got.Data.Items[1].ApprovedQty != 2 {
		t.Errorf("approval result: %+v", got.Data)
	}
}

func (f *rqFixture) reject(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 1))
	f.submit(t, id)
	code, body := f.call("wh", "POST", "/requisitions/"+id+"/reject", map[string]any{"note": "  "}, f.key())
	f.want(t, code, body, 400, "reject without a note")
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/reject", map[string]any{"note": "stok kosong"}, f.key())
	f.want(t, code, body, 200, "reject")
	if st := f.decode(t, body).Data.Status; st != "rejected" {
		t.Fatalf("status %s", st)
	}
	code, body = f.approve(t, id, 1)
	f.want(t, code, body, 409, "approve a rejected PB")
	code, body = f.call("staffA", "POST", "/requisitions/"+id+"/cancel", nil, f.key())
	f.want(t, code, body, 409, "cancel a rejected PB")
}

func (f *rqFixture) transfers(t *testing.T) int { return f.count(t, `SELECT count(*) FROM transfers`) }

func (f *rqFixture) fulfil(t *testing.T) {
	p, q, z := f.product(t), f.product(t), f.product(t)
	id := f.create(t, "staffA", rqLine(p, 5), rqLine(q, 3), rqLine(z, 2))
	f.submit(t, id)
	pb := f.get(t, "wh", id)
	byProduct := map[string]int{}
	for i, it := range pb.Data.Items {
		byProduct[it.ProductID] = i
	}
	qty := make([]int, 3)
	qty[byProduct[p]], qty[byProduct[q]], qty[byProduct[z]] = 4, 3, 0
	code, body := f.approve(t, id, qty...)
	f.want(t, code, body, 200, "approve")

	before := f.transfers(t)
	key := f.key()
	code, first := f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, key)
	f.want(t, code, first, 201, "fulfil")
	var res struct {
		Data struct{ TransferID, TransferNo string }
	}
	if err := json.Unmarshal([]byte(strings.ReplaceAll(strings.ReplaceAll(first, `"transferId"`, `"TransferID"`), `"transferNo"`, `"TransferNo"`)), &res); err != nil || res.Data.TransferID == "" {
		t.Fatalf("fulfil body %s: %v", first, err)
	}
	if f.transfers(t) != before+1 {
		t.Fatalf("fulfil created %d transfers, want exactly 1", f.transfers(t)-before)
	}
	// The draft is gudang -> toko with the approved quantities; the zero line is skipped.
	tid := res.Data.TransferID
	if st := f.str(t, `SELECT status FROM transfers WHERE id=$1`, tid); st != "draft" {
		t.Errorf("transfer status %s, want draft", st)
	}
	var sw, do string
	if err := f.pool.QueryRow(f.ctx, `SELECT source_warehouse_id::text, dest_outlet_id::text FROM transfers WHERE id=$1`, tid).Scan(&sw, &do); err != nil || sw != rqWarehouse || do != rqOutletA {
		t.Errorf("transfer route %s -> %s (%v), want gudang -> outlet A", sw, do, err)
	}
	if n := f.count(t, `SELECT count(*) FROM transfer_items WHERE transfer_id=$1`, tid); n != 2 {
		t.Errorf("transfer has %d lines, want 2 (zero-approved line skipped)", n)
	}
	if n := f.count(t, `SELECT sent_qty FROM transfer_items WHERE transfer_id=$1 AND product_id=$2`, tid, p); n != 4 {
		t.Errorf("line qty %d, want the approved 4", n)
	}
	if n := f.count(t, `SELECT count(*) FROM transfer_items WHERE transfer_id=$1 AND product_id=$2`, tid, z); n != 0 {
		t.Error("a zero-approved line reached the transfer")
	}
	if n := f.count(t, `SELECT count(*) FROM stock_movements WHERE ref_id=$1`, tid); n != 0 {
		t.Errorf("a transfer draft wrote %d ledger rows", n)
	}
	linked := f.get(t, "wh", id)
	if linked.Data.Status != "fulfilled" || linked.Data.Transfer == nil || linked.Data.Transfer.ID != tid || linked.Data.Transfer.Status != "draft" {
		t.Fatalf("PB not linked: %+v", linked.Data)
	}
	if f.get(t, "staffA", id).Data.Transfer == nil {
		t.Error("the outlet cannot see the linked transfer")
	}

	// An idempotent replay answers the same body and makes no second transfer.
	code, replay := f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, key)
	f.want(t, code, replay, 201, "fulfil replay")
	if replay != first {
		t.Errorf("replay body %s differs from the first answer %s", replay, first)
	}
	if f.transfers(t) != before+1 {
		t.Fatal("a replay created another transfer")
	}
	// A new key while the linked transfer is alive: refused, still one transfer.
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 409, "re-fulfil with a live transfer")
	if f.transfers(t) != before+1 {
		t.Fatal("a refused re-fulfil created a transfer")
	}

	// Cancel the draft: now the warehouse may fulfil again, with a new link and event.
	if err := f.repo.CancelTransfer(f.ctx, tid); err != nil {
		t.Fatal(err)
	}
	if st := f.get(t, "wh", id).Data.Transfer.Status; st != "cancelled" {
		t.Errorf("live transfer status %s, want cancelled", st)
	}
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 201, "re-fulfil after cancel")
	if err := json.Unmarshal([]byte(strings.ReplaceAll(body, `"transferId"`, `"TransferID"`)), &res); err != nil || res.Data.TransferID == tid {
		t.Fatalf("re-fulfil reused transfer %s: %v", tid, err)
	}
	relinked := f.get(t, "wh", id)
	if relinked.Data.Transfer.ID != res.Data.TransferID || relinked.Data.Transfer.Status != "draft" {
		t.Errorf("new link missing: %+v", relinked.Data.Transfer)
	}
	if f.count(t, `SELECT count(*) FROM inventory_doc_events WHERE doc_id=$1 AND action='refulfilled'`, id) != 1 {
		t.Error("no 'refulfilled' event")
	}

	// Approving with every line 0 would strand the PB: refused, the PB stays submitted.
	zid := f.create(t, "staffA", rqLine(f.product(t), 1))
	f.submit(t, zid)
	code, body = f.approve(t, zid, 0)
	f.want(t, code, body, 400, "approve all zero")
	if f.get(t, "wh", zid).Data.Status != "submitted" {
		t.Error("a refused all-zero approval changed the PB")
	}
	// Defence in depth: a PB whose approved qty ended up all zero still cannot fulfil.
	code, body = f.approve(t, zid, 1)
	f.want(t, code, body, 200, "approve")
	f.exec(t, `UPDATE stock_requisition_items SET approved_qty=0 WHERE requisition_id=$1`, zid)
	n := f.transfers(t)
	code, body = f.call("wh", "POST", "/requisitions/"+zid+"/fulfil", nil, f.key())
	f.want(t, code, body, 409, "fulfil with nothing approved")
	if f.transfers(t) != n || f.get(t, "wh", zid).Data.Status != "approved" {
		t.Error("an empty fulfil changed state")
	}
}

// transferQty shows the linked draft's real line quantity, which the warehouse may edit there.
func (f *rqFixture) transferQty(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 5))
	f.submit(t, id)
	if code, body := f.approve(t, id, 4); code != 200 {
		t.Fatalf("approve: %d %s", code, body)
	}
	if got := f.get(t, "staffA", id).Data.Items[0].TransferQty; got != nil {
		t.Errorf("transferQty %v before a transfer exists", *got)
	}
	code, body := f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 201, "fulfil")
	f.exec(t, `UPDATE transfer_items SET sent_qty=3 WHERE transfer_id=(SELECT transfer_id FROM stock_requisitions WHERE id=$1)`, id)
	it := f.get(t, "staffA", id).Data.Items[0]
	if it.TransferQty == nil || *it.TransferQty != 3 || *it.ApprovedQty != 4 {
		t.Errorf("approved %v transfer %v, want 4 and 3", it.ApprovedQty, it.TransferQty)
	}
}

// A product or warehouse named by a PB cannot be deleted (history 409, not a raw FK error);
// a source gudang deactivated after approval blocks the fulfil.
func (f *rqFixture) deletesAndInactive(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 1))
	code, body := f.call("wh", "DELETE", "/products/"+p, nil, "")
	f.want(t, code, body, 409, "delete a product named by a PB")
	f.submit(t, id)
	if code, body := f.approve(t, id, 1); code != 200 {
		t.Fatalf("approve: %d %s", code, body)
	}
	code, body = f.call("wh", "DELETE", "/warehouses/"+rqWarehouse, nil, "")
	f.want(t, code, body, 409, "delete a warehouse named by a PB")
	f.exec(t, `UPDATE warehouses SET is_active=false WHERE id=$1`, rqWarehouse)
	defer f.exec(t, `UPDATE warehouses SET is_active=true WHERE id=$1`, rqWarehouse)
	n := f.transfers(t)
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 409, "fulfil from an inactive gudang")
	if f.transfers(t) != n {
		t.Error("a refused fulfil created a transfer")
	}
}

func (f *rqFixture) fulfilConcurrent(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 2))
	f.submit(t, id)
	if code, body := f.approve(t, id, 2); code != 200 {
		t.Fatalf("approve: %d %s", code, body)
	}
	before := f.transfers(t)
	var wg sync.WaitGroup
	codes := make([]int, 6)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, fmt.Sprintf("rq-conc-%d", i))
		}()
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		if c == 201 {
			created++
		} else if c != 409 {
			t.Errorf("concurrent fulfil answered %d, want 201 or 409", c)
		}
	}
	if created != 1 || f.transfers(t) != before+1 {
		t.Fatalf("%d fulfils won and %d transfers exist, want exactly one of each", created, f.transfers(t)-before)
	}
}

func (f *rqFixture) history(t *testing.T) {
	p := f.product(t)
	id := f.create(t, "staffA", rqLine(p, 2))
	f.submit(t, id)
	if code, body := f.approve(t, id, 2); code != 200 {
		t.Fatalf("approve: %d %s", code, body)
	}
	if code, body := f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key()); code != 201 {
		t.Fatalf("fulfil: %d %s", code, body)
	}
	var got []string
	for _, e := range f.get(t, "wh", id).Data.Events {
		got = append(got, e.Action)
	}
	if strings.Join(got, ",") != "created,submitted,approved,fulfilled" {
		t.Errorf("events %v, want created,submitted,approved,fulfilled", got)
	}
	// Cancel and reject also leave a row; the history is insert-only (a Go guard test covers the code).
	c := f.create(t, "staffA", rqLine(p, 1))
	f.call("staffA", "POST", "/requisitions/"+c+"/cancel", nil, f.key())
	if f.count(t, `SELECT count(*) FROM inventory_doc_events WHERE doc_type='requisition' AND doc_id=$1 AND action='cancelled'`, c) != 1 {
		t.Error("no 'cancelled' event")
	}
	r := f.create(t, "staffA", rqLine(p, 1))
	f.submit(t, r)
	f.call("wh", "POST", "/requisitions/"+r+"/reject", map[string]any{"note": "tidak"}, f.key())
	if f.count(t, `SELECT count(*) FROM inventory_doc_events WHERE doc_type='requisition' AND doc_id=$1 AND action='rejected'`, r) != 1 {
		t.Error("no 'rejected' event")
	}
}

// The user who created or submitted a PB may not approve, reject or fulfil it, even as admin.
func (f *rqFixture) fourEyes(t *testing.T) {
	p := f.product(t)
	hdr := []string{"X-Outlet-Id", rqOutletA}
	// Creator: admin creates and submits a PB for outlet A, then tries to decide on it.
	code, body := f.call("admin", "POST", "/requisitions", rqLines(rqLine(p, 2)), f.key(), hdr...)
	f.want(t, code, body, 201, "admin creates")
	id := f.decode(t, body).Data.ID
	code, body = f.call("admin", "POST", "/requisitions/"+id+"/submit", nil, f.key(), hdr...)
	f.want(t, code, body, 200, "admin submits")
	pb := f.get(t, "wh", id)
	approval := map[string]any{"warehouseId": rqWarehouse, "items": []map[string]any{{"itemId": pb.Data.Items[0].ID, "approvedQty": 2}}}
	code, body = f.call("admin", "POST", "/requisitions/"+id+"/approve", approval, f.key())
	f.want(t, code, body, 409, "creator approves")
	if !strings.Contains(body, "tidak boleh") {
		t.Errorf("four-eyes message missing: %s", body)
	}
	code, body = f.call("admin", "POST", "/requisitions/"+id+"/reject", map[string]any{"note": "x"}, f.key())
	f.want(t, code, body, 409, "creator rejects")
	if st := f.get(t, "wh", id).Data.Status; st != "submitted" {
		t.Fatalf("a refused four-eyes action changed the PB to %s", st)
	}
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/approve", approval, f.key())
	f.want(t, code, body, 200, "another user approves")
	code, body = f.call("admin", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 409, "creator fulfils")
	code, body = f.call("wh", "POST", "/requisitions/"+id+"/fulfil", nil, f.key())
	f.want(t, code, body, 201, "another user fulfils")

	// Submitter: staff A creates, an admin (acting for outlet A) submits, so the admin may not decide.
	sid := f.create(t, "staffA", rqLine(p, 1))
	code, body = f.call("admin", "POST", "/requisitions/"+sid+"/submit", nil, f.key(), hdr...)
	f.want(t, code, body, 200, "admin submits staff A's draft")
	code, body = f.call("admin", "POST", "/requisitions/"+sid+"/reject", map[string]any{"note": "x"}, f.key())
	f.want(t, code, body, 409, "submitter rejects")
	code, body = f.call("wh", "POST", "/requisitions/"+sid+"/reject", map[string]any{"note": "x"}, f.key())
	f.want(t, code, body, 200, "another user rejects")
}
