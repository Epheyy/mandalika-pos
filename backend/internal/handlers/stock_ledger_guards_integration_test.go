package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/ledger"
	"github.com/mandalika/pos-backend/internal/write"
)

// slGuardFx drives the D13 guards (plan §2.3 rows 10-15) through the real handlers: a
// variant rename or delete, a product delete, a warehouse delete and a CSV rename must
// never move or destroy stock. A stocked key is refused with 409 and the message names
// the location; an empty key is moved or deleted in the outlet AND warehouse tables;
// an outlet-config save keeps live stock rows. stock_movements stays equal to live stock
// after every step.
type slGuardFx struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	h      *Handlers
	router http.Handler
	n      int
}

const slGuardHeader = "Nama,Brand,Kategori,Deskripsi,Ukuran,Harga,SKU,Barcode,Jual,Aktif,Unggulan\n"

func newSLGuardFx(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *slGuardFx {
	slSetup(t, ctx, pool)
	f := &slGuardFx{t: t, ctx: ctx, pool: pool, h: &Handlers{Write: write.New(pool)}}
	f.exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL warehouse') ON CONFLICT DO NOTHING`, slWarehouse)
	// import_runs.user_id is a foreign key: the acting user must exist
	f.exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'slg@example.invalid','x','SL guard admin','admin') ON CONFLICT DO NOTHING`, slInvUser)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), auth.CtxUserID, slInvUser)))
		})
	})
	r.Post("/products", f.h.CreateProduct)
	r.Put("/products/{id}", f.h.UpdateProduct)
	r.Delete("/products/{id}", f.h.DeleteProduct)
	r.Put("/products/{id}/outlet-config", f.h.PutProductOutletConfig)
	r.Delete("/warehouses/{id}", f.h.DeleteWarehouse)
	r.Post("/products/import", f.h.ImportProducts)
	f.router = r
	return f
}

func (f *slGuardFx) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *slGuardFx) count(sql string, args ...any) (n int) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *slGuardFx) do(method, path string, body any, headers ...string) *httptest.ResponseRecorder {
	f.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		f.t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req)
	return w
}

// product creates a product with zero-stock variants of the given sizes (SKU
// "SLG-<name>-<size>") and returns its id and the variant ids by size.
func (f *slGuardFx) product(name string, sizes ...string) (string, map[string]string) {
	f.t.Helper()
	vs := make([]write.Variant, len(sizes))
	for i, s := range sizes {
		vs[i] = write.Variant{Size: s, Price: 1000, SKU: "SLG-" + name + "-" + s}
	}
	pid, err := f.h.Write.CreateProduct(f.ctx, "", write.Product{Name: "SLG " + name, Brand: "SLG", Sellable: true, IsActive: true, Variants: vs})
	if err != nil {
		f.t.Fatal(err)
	}
	ids := map[string]string{}
	for _, s := range sizes {
		var id string
		if err := f.pool.QueryRow(f.ctx, `SELECT id::text FROM product_variants WHERE product_id=$1 AND size=$2`, pid, s).Scan(&id); err != nil {
			f.t.Fatal(err)
		}
		ids[s] = id
	}
	return pid, ids
}

// variant builds a payload variant; id "" is a new variant.
func slGuardVariant(name, id, size, sku string) write.Variant {
	if sku == "" {
		sku = "SLG-" + name + "-" + size
	}
	return write.Variant{ID: id, Size: size, Price: 1000, SKU: sku}
}

func (f *slGuardFx) putProduct(name, pid string, vs ...write.Variant) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(http.MethodPut, "/products/"+pid, write.Product{Name: "SLG " + name, Brand: "SLG", Sellable: true, IsActive: true, Variants: vs})
}

func (f *slGuardFx) outlet(pid, size string, qty int) {
	f.t.Helper()
	f.exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)
	        ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=EXCLUDED.stock`, slOutletA, pid, size, qty)
}

func (f *slGuardFx) warehouse(wh, pid, size string, qty int) {
	f.t.Helper()
	f.exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)
	        ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock=EXCLUDED.stock`, wh, pid, size, qty)
}

// open records the stock seeded straight into the tables as opening movements, then checks
// the invariant.
func (f *slGuardFx) open() {
	f.t.Helper()
	f.n++
	slBackfill(f.t, f.ctx, f.pool, ledger.BackfillOptions{RunID: fmt.Sprintf("guards-%d", f.n)})
	assertLedgerInvariant(f.t, f.ctx, f.pool)
}

func (f *slGuardFx) rows(table, pid, size string) int {
	f.t.Helper()
	return f.count(`SELECT count(*)::int FROM `+table+` WHERE product_id=$1 AND variant_size=$2`, pid, size)
}

// conflict wants the D13 variant refusal; productConflict and warehouseConflict the
// delete forms of it, which point to deactivating instead of zeroing.
func (f *slGuardFx) conflict(w *httptest.ResponseRecorder, what string, contains ...string) {
	f.t.Helper()
	f.conflictWith(w, what, append([]string{"varian masih punya stok di", "nolkan lewat penyesuaian dulu"}, contains...))
}

func (f *slGuardFx) productConflict(w *httptest.ResponseRecorder, what string, contains ...string) {
	f.t.Helper()
	f.conflictWith(w, what, append([]string{"produk masih punya stok di", "nonaktifkan produk saja (matikan Produk Aktif)"}, contains...))
}

func (f *slGuardFx) warehouseConflict(w *httptest.ResponseRecorder, what string, contains ...string) {
	f.t.Helper()
	f.conflictWith(w, what, append([]string{"gudang masih punya stok di", "nonaktifkan gudang saja (matikan Gudang Aktif)"}, contains...))
}

func (f *slGuardFx) conflictWith(w *httptest.ResponseRecorder, what string, want []string) {
	f.t.Helper()
	if w.Code != http.StatusConflict {
		f.t.Fatalf("%s: %d %s, want 409", what, w.Code, w.Body.String())
	}
	for _, c := range want {
		if !strings.Contains(w.Body.String(), c) {
			f.t.Fatalf("%s: body %s lacks %q", what, w.Body.String(), c)
		}
	}
	assertLedgerInvariant(f.t, f.ctx, f.pool)
}

func (f *slGuardFx) ok(w *httptest.ResponseRecorder, what string) {
	f.t.Helper()
	if w.Code != http.StatusOK {
		f.t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
	}
	assertLedgerInvariant(f.t, f.ctx, f.pool)
}

func slGuards(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	f := newSLGuardFx(t, ctx, pool)
	t.Run("create-refuses-opening-stock", f.createRefusesOpeningStock)
	t.Run("update-ignores-input-stock", f.updateIgnoresInputStock)
	t.Run("variant-delete", f.variantDelete)
	t.Run("variant-rename", f.variantRename)
	t.Run("product-and-warehouse-delete", f.productAndWarehouseDelete)
	t.Run("outlet-config-keeps-stock", f.outletConfig)
	t.Run("csv-rename", f.csvRename)
	t.Run("rename-onto-leftover-rows", f.renameOntoResidue)
	t.Run("warehouse-delete-vs-open-receipt", f.warehouseDeleteRace)
	t.Run("csv-apply-guard", f.csvApplyGuard)
}

// D12: a create with a non-zero variant stock is a 400 that writes nothing; a create with 0
// writes the product and variant but no stock row and no movement.
func (f *slGuardFx) createRefusesOpeningStock(t *testing.T) {
	payload := func(name string, stock int) write.Product {
		return write.Product{Name: name, Brand: "SLG", Sellable: true, IsActive: true,
			Variants: []write.Variant{{Size: "100ml", Price: 1000, Stock: stock, SKU: "SLG-" + name}}}
	}
	for _, stock := range []int{5, -3} {
		name := fmt.Sprintf("d12-refused%d", stock)
		w := f.do(http.MethodPost, "/products", payload(name, stock))
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "Penerimaan Barang") {
			t.Fatalf("create with stock %d: %d %s, want 400 naming Penerimaan Barang", stock, w.Code, w.Body.String())
		}
		if n := f.count(`SELECT count(*)::int FROM products WHERE name=$1`, name); n != 0 {
			t.Fatalf("refused create left %d product rows", n)
		}
		if n := f.count(`SELECT count(*)::int FROM product_variants WHERE sku=$1`, "SLG-"+name); n != 0 {
			t.Fatalf("refused create left %d variant rows", n)
		}
	}
	before := f.count(`SELECT count(*)::int FROM stock_movements`)
	w := f.do(http.MethodPost, "/products", payload("d12-zero", 0))
	if w.Code != http.StatusCreated {
		t.Fatalf("create with stock 0: %d %s", w.Code, w.Body.String())
	}
	pid := f.str(`SELECT id::text FROM products WHERE name='d12-zero'`)
	if n := f.rows("outlet_variant_stock", pid, "100ml") + f.rows("warehouse_variant_stock", pid, "100ml"); n != 0 {
		t.Fatalf("zero create wrote %d stock rows", n)
	}
	if after := f.count(`SELECT count(*)::int FROM stock_movements`); after != before {
		t.Fatalf("zero create wrote %d movements", after-before)
	}
	assertLedgerInvariant(t, f.ctx, f.pool)
}

func (f *slGuardFx) str(sql string, args ...any) (s string) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&s); err != nil {
		f.t.Fatal(err)
	}
	return s
}

// UpdateProduct still ignores input stock (no refusal): neither the frozen
// product_variants.stock nor live stock moves.
func (f *slGuardFx) updateIgnoresInputStock(t *testing.T) {
	pid, vids := f.product("d12-upd", "a")
	f.outlet(pid, "a", 4)
	f.open()
	frozen := f.count(`SELECT stock FROM product_variants WHERE id=$1`, vids["a"])
	v := slGuardVariant("d12-upd", vids["a"], "a", "")
	v.Stock = 99
	f.ok(f.putProduct("d12-upd", pid, v), "update with a different input stock")
	if got := f.count(`SELECT stock FROM product_variants WHERE id=$1`, vids["a"]); got != frozen {
		t.Fatalf("product_variants.stock %d -> %d, want frozen", frozen, got)
	}
	if got := f.count(`SELECT stock FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='a'`, pid); got != 4 {
		t.Fatalf("live stock %d, want 4", got)
	}
	nv := slGuardVariant("d12-upd", "", "b", "")
	nv.Stock = 50
	f.ok(f.putProduct("d12-upd", pid, v, nv), "update adding a variant with input stock")
	if got := f.count(`SELECT stock FROM product_variants WHERE product_id=$1 AND size='b'`, pid); got != 0 {
		t.Fatalf("new variant product_variants.stock %d, want 0 (DEFAULT)", got)
	}
	if n := f.rows("outlet_variant_stock", pid, "b"); n != 0 {
		t.Fatalf("new variant got %d stock rows", n)
	}
	assertLedgerInvariant(t, f.ctx, f.pool)
}

func (f *slGuardFx) variantDelete(t *testing.T) {
	keepOnly := func(name string, vids map[string]string) write.Variant {
		return slGuardVariant(name, vids["a"], "a", "")
	}
	cases := []struct {
		name, what string
		seed       func(pid string)
		contains   string
	}{
		{"vd-outlet", "outlet stock 3", func(pid string) { f.outlet(pid, "b", 3) }, "SL outlet A"},
		{"vd-wh", "warehouse stock 2", func(pid string) { f.warehouse(slWarehouse, pid, "b", 2) }, "gudang SL warehouse"},
		{"vd-neg", "negative outlet stock", func(pid string) { f.outlet(pid, "b", -1) }, "SL outlet A"},
	}
	for _, c := range cases {
		pid, vids := f.product(c.name, "a", "b")
		c.seed(pid)
		f.open()
		f.conflict(f.putProduct(c.name, pid, keepOnly(c.name, vids)), c.what, c.contains, "ukuran b")
		if f.count(`SELECT count(*)::int FROM product_variants WHERE product_id=$1`, pid) != 2 ||
			f.rows("outlet_variant_stock", pid, "b")+f.rows("warehouse_variant_stock", pid, "b") != 1 {
			t.Fatalf("%s: a refused delete must keep the variant and its stock row", c.what)
		}
	}
	// every row of the removed size is empty: variant and ALL its rows go, in both tables
	pid, vids := f.product("vd-zero", "a", "b")
	f.outlet(pid, "b", 0)
	f.warehouse(slWarehouse, pid, "b", 0)
	f.exec(`INSERT INTO outlet_variant_price(outlet_id,product_id,variant_size,price) VALUES($1,$2,'b',5)`, slOutletA, pid)
	f.ok(f.putProduct("vd-zero", pid, keepOnly("vd-zero", vids)), "delete of an empty variant")
	if f.count(`SELECT count(*)::int FROM product_variants WHERE product_id=$1`, pid) != 1 ||
		f.rows("outlet_variant_stock", pid, "b")+f.rows("warehouse_variant_stock", pid, "b")+f.rows("outlet_variant_price", pid, "b") != 0 {
		t.Fatal("an empty variant delete must leave no outlet, warehouse or price rows")
	}
}

func (f *slGuardFx) variantRename(t *testing.T) {
	for _, c := range []struct {
		name, contains string
		seed           func(pid string)
	}{
		{"vr-outlet", "SL outlet A", func(pid string) { f.outlet(pid, "a", 4) }},
		{"vr-wh", "gudang SL warehouse", func(pid string) { f.warehouse(slWarehouse, pid, "a", 2) }},
	} {
		pid, vids := f.product(c.name, "a")
		c.seed(pid)
		f.open()
		f.conflict(f.putProduct(c.name, pid, slGuardVariant(c.name, vids["a"], "a2", "SLG-"+c.name+"-a")), c.name, c.contains)
		var size string
		if err := f.pool.QueryRow(f.ctx, `SELECT size FROM product_variants WHERE id=$1`, vids["a"]).Scan(&size); err != nil || size != "a" {
			t.Fatalf("%s: refused rename changed the variant size to %q (%v)", c.name, size, err)
		}
		if f.rows("outlet_variant_stock", pid, "a2")+f.rows("warehouse_variant_stock", pid, "a2") != 0 {
			t.Fatalf("%s: a refused rename moved a stock key", c.name)
		}
	}
	pid, vids := f.product("vr-zero", "a")
	f.outlet(pid, "a", 0)
	f.warehouse(slWarehouse, pid, "a", 0)
	f.exec(`INSERT INTO outlet_variant_price(outlet_id,product_id,variant_size,price) VALUES($1,$2,'a',5)`, slOutletA, pid)
	f.ok(f.putProduct("vr-zero", pid, slGuardVariant("vr-zero", vids["a"], "a2", "SLG-vr-zero-a")), "rename of an empty variant")
	for _, tb := range []string{"outlet_variant_stock", "warehouse_variant_stock", "outlet_variant_price"} {
		if f.rows(tb, pid, "a2") != 1 || f.rows(tb, pid, "a") != 0 {
			t.Fatalf("%s: the empty key must move a -> a2 in every table", tb)
		}
	}
}

func (f *slGuardFx) productAndWarehouseDelete(t *testing.T) {
	pid, _ := f.product("pd-stock", "a")
	f.outlet(pid, "a", 3)
	f.open()
	f.productConflict(f.do(http.MethodDelete, "/products/"+pid, nil), "product delete with stock", "SL outlet A")
	if f.count(`SELECT count(*)::int FROM products WHERE id=$1`, pid) != 1 || f.rows("outlet_variant_stock", pid, "a") != 1 {
		t.Fatal("a refused product delete must keep the product and its stock row")
	}
	zero, _ := f.product("pd-zero", "a")
	f.outlet(zero, "a", 0)
	f.warehouse(slWarehouse, zero, "a", 0)
	f.ok(f.do(http.MethodDelete, "/products/"+zero, nil), "product delete with empty rows")
	if f.count(`SELECT count(*)::int FROM products WHERE id=$1`, zero) != 0 ||
		f.rows("outlet_variant_stock", zero, "a")+f.rows("warehouse_variant_stock", zero, "a") != 0 {
		t.Fatal("an empty product delete must remove the product and its rows")
	}

	const whStocked, whEmpty = "00000000-0000-4000-8f67-0000000000d2", "00000000-0000-4000-8f67-0000000000d3"
	f.exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL wh stocked'),($2,'SL wh empty') ON CONFLICT DO NOTHING`, whStocked, whEmpty)
	wp, _ := f.product("wd", "a")
	f.warehouse(whStocked, wp, "a", 2)
	f.warehouse(whEmpty, wp, "a", 0)
	f.open()
	f.warehouseConflict(f.do(http.MethodDelete, "/warehouses/"+whStocked, nil), "warehouse delete with stock", "gudang SL wh stocked")
	if f.count(`SELECT count(*)::int FROM warehouses WHERE id=$1`, whStocked) != 1 {
		t.Fatal("a refused warehouse delete must keep the warehouse")
	}
	f.ok(f.do(http.MethodDelete, "/warehouses/"+whEmpty, nil), "warehouse delete with empty rows")
	if f.count(`SELECT count(*)::int FROM warehouses WHERE id=$1`, whEmpty) != 0 ||
		f.count(`SELECT count(*)::int FROM warehouse_variant_stock WHERE warehouse_id=$1`, whEmpty) != 0 {
		t.Fatal("an empty warehouse delete must remove the warehouse and its rows")
	}
}

func (f *slGuardFx) outletConfig(t *testing.T) {
	pid, _ := f.product("oc", "a", "b")
	f.outlet(pid, "a", 5)
	f.outlet(pid, "b", 0)
	f.outlet(pid, "ghost0", 0)
	f.outlet(pid, "ghost5", 5)
	f.open()
	body := map[string]any{"items": []map[string]any{{"outletId": slOutletA, "variantSize": "b", "available": true}}}
	f.ok(f.do(http.MethodPut, "/products/"+pid+"/outlet-config", body), "partial outlet config")
	for size, want := range map[string]int{"a": 1, "b": 1, "ghost0": 0, "ghost5": 1} {
		if got := f.rows("outlet_variant_stock", pid, size); got != want {
			t.Fatalf("size %s: %d stock rows after a partial config save, want %d", size, got, want)
		}
	}
	if f.count(`SELECT stock FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='a'`, pid) != 5 {
		t.Fatal("a partial payload must not touch the live stock of a listed-elsewhere variant")
	}
}

type slGuardReport struct {
	Data csvimport.Report `json:"data"`
}

func (f *slGuardFx) importCSV(csv string, dry bool, rep csvimport.Report, key string) (int, csvimport.Report) {
	f.t.Helper()
	body := map[string]any{"csv": csv, "dryRun": dry}
	headers := []string{}
	if !dry {
		body["fileSha256"], body["expectedSummary"] = rep.FileSHA256, rep.Summary
		headers = []string{"Idempotency-Key", key}
	}
	w := f.do(http.MethodPost, "/products/import", body, headers...)
	var out slGuardReport
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out.Data
}

func slGuardHasCode(rep csvimport.Report, code string) bool {
	for _, i := range rep.Issues {
		if i.Code == code && strings.Contains(i.Message, "SL outlet A") {
			return true
		}
	}
	return false
}

func (f *slGuardFx) csvRename(t *testing.T) {
	// a stocked size: the preview names the outlet and apply refuses (422)
	pid, vids := f.product("csv-stock", "a")
	f.outlet(pid, "a", 3)
	f.open()
	csv := slGuardHeader + "SLG csv-stock,SLG,,,a2,1000,SLG-csv-stock-a,,,,\n"
	code, rep := f.importCSV(csv, true, csvimport.Report{}, "")
	if code != http.StatusOK || !rep.HasErrors() || !slGuardHasCode(rep, "size_has_stock") {
		t.Fatalf("preview of a stocked rename: %d %+v", code, rep.Issues)
	}
	if code, _ := f.importCSV(csv, false, rep, "sl-csv-1"); code != http.StatusUnprocessableEntity {
		t.Fatalf("apply of a stocked rename: %d, want 422", code)
	}
	var size string
	_ = f.pool.QueryRow(f.ctx, `SELECT size FROM product_variants WHERE id=$1`, vids["a"]).Scan(&size)
	if size != "a" || f.rows("outlet_variant_stock", pid, "a") != 1 || f.rows("outlet_variant_stock", pid, "a2") != 0 {
		t.Fatalf("a refused CSV rename changed data (size %q)", size)
	}

	// a stale preview: it was clean (empty keys), then stock arrived; apply must not rename
	sp, svids := f.product("csv-stale", "a")
	f.outlet(sp, "a", 0)
	scsv := slGuardHeader + "SLG csv-stale,SLG,,,a2,1000,SLG-csv-stale-a,,,,\n"
	_, clean := f.importCSV(scsv, true, csvimport.Report{}, "")
	if clean.HasErrors() || clean.Summary.Update != 1 {
		t.Fatalf("empty-key rename preview must be clean: %+v", clean.Issues)
	}
	f.outlet(sp, "a", 2)
	f.open()
	if code, _ := f.importCSV(scsv, false, clean, "sl-csv-2"); code != http.StatusConflict {
		t.Fatalf("apply of a stale preview: %d, want 409", code)
	}
	_ = f.pool.QueryRow(f.ctx, `SELECT size FROM product_variants WHERE id=$1`, svids["a"]).Scan(&size)
	if size != "a" || f.rows("outlet_variant_stock", sp, "a2") != 0 {
		t.Fatalf("a stale CSV rename must change nothing (size %q)", size)
	}

	// zero the stock through the adjust writer; now the rename moves outlet and warehouse keys
	if err := f.h.Write.AdjustLocationStock(f.ctx, "outlet", slOutletA, slInvUser,
		write.WarehouseAdjust{ProductID: sp, VariantSize: "a", NewQty: 0, Reason: "uji"}); err != nil {
		t.Fatal(err)
	}
	f.warehouse(slWarehouse, sp, "a", 0)
	_, ready := f.importCSV(scsv, true, csvimport.Report{}, "")
	if code, _ := f.importCSV(scsv, false, ready, "sl-csv-3"); code != http.StatusOK {
		t.Fatalf("apply of an empty-key rename: %d", code)
	}
	for _, tb := range []string{"outlet_variant_stock", "warehouse_variant_stock"} {
		if f.rows(tb, sp, "a2") != 1 || f.rows(tb, sp, "a") != 0 {
			t.Fatalf("%s: the empty key must move a -> a2", tb)
		}
	}
	assertLedgerInvariant(t, f.ctx, f.pool)
}

// waitLockWait polls until some backend is blocked on a heavyweight lock, bounded so a
// regression fails instead of hanging.
func (f *slGuardFx) waitLockWait() {
	f.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if f.count(`SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatal("the writer never blocked on the held lock")
}

// A form rename onto a size that still has orphan rows is a clean 409, not a raw 23505.
func (f *slGuardFx) renameOntoResidue(t *testing.T) {
	pid, vids := f.product("rr", "a")
	f.outlet(pid, "a", 0)
	f.warehouse(slWarehouse, pid, "orphan", 0)
	w := f.putProduct("rr", pid, slGuardVariant("rr", vids["a"], "orphan", "SLG-rr-a"))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "sisa baris stok atau harga") {
		t.Fatalf("rename onto leftover rows: %d %s", w.Code, w.Body.String())
	}
	assertLedgerInvariant(t, f.ctx, f.pool)
}

// A goods receipt that has inserted a warehouse stock row but not committed holds KEY SHARE
// on the warehouse. The delete must wait for it, then see the row and refuse; the cascade
// must never remove the committed receipt row.
func (f *slGuardFx) warehouseDeleteRace(t *testing.T) {
	const wh = "00000000-0000-4000-8f67-0000000000d4"
	f.exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL wh race') ON CONFLICT DO NOTHING`, wh)
	pid, _ := f.product("wr", "a")
	receipt, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer receipt.Rollback(f.ctx)
	if _, err = receipt.Exec(f.ctx, `INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'a',10)`, wh, pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- f.do(http.MethodDelete, "/warehouses/"+wh, nil) }()
	f.waitLockWait()
	if err = receipt.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	w := <-done
	f.open() // the receipt row had no movement; record it so the invariant can be checked
	f.warehouseConflict(w, "delete racing an open receipt", "gudang SL wh race")
	if f.rows("warehouse_variant_stock", pid, "a") != 1 {
		t.Fatal("the receipt row must survive the refused delete")
	}
}

// The apply-path guard itself: the plan was clean, stock arrives while apply waits for a
// row lock, and apply (not the summary check) refuses.
func (f *slGuardFx) csvApplyGuard(t *testing.T) {
	pid, vids := f.product("csv-race", "a")
	f.outlet(pid, "a", 0)
	csv := slGuardHeader + "SLG csv-race,SLG,,,a2,1000,SLG-csv-race-a,,,,\n"
	_, rep := f.importCSV(csv, true, csvimport.Report{}, "")
	if rep.HasErrors() || rep.Summary.Update != 1 {
		t.Fatalf("preview must be clean: %+v", rep.Issues)
	}
	holder, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(f.ctx)
	if _, err = holder.Exec(f.ctx, `UPDATE product_variants SET price=price WHERE id=$1`, vids["a"]); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- f.do(http.MethodPost, "/products/import", map[string]any{"csv": csv, "dryRun": false,
			"fileSha256": rep.FileSHA256, "expectedSummary": rep.Summary}, "Idempotency-Key", "sl-csv-race")
	}()
	f.waitLockWait()
	f.outlet(pid, "a", 2) // committed while the apply is parked behind the holder
	f.open()
	if err = holder.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	w := <-done
	f.conflict(w, "apply with stock that arrived after planning", "SL outlet A")
	if strings.Contains(w.Body.String(), "import_stale") {
		t.Fatalf("the refusal must come from the apply guard, not the stale check: %s", w.Body.String())
	}
	var size string
	_ = f.pool.QueryRow(f.ctx, `SELECT size FROM product_variants WHERE id=$1`, vids["a"]).Scan(&size)
	if size != "a" || f.rows("outlet_variant_stock", pid, "a2") != 0 {
		t.Fatalf("a refused apply must change nothing (size %q)", size)
	}
}
