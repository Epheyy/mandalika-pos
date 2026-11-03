package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	erp "github.com/mandalika/pos-backend/internal/integration/erp"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
)

// Fase D D2-API: the optional list parameters of the backoffice (products, promotions, discount
// codes, goods receipts, approvals), the ERP location names and the stable paging tie-breaks.
// Driven through the real handlers; opt-in fresh synthetic cluster (port 56478, prefix LP).
func TestListParamsPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "LP", 56478)
	const (
		outA   = "00000000-0000-4000-8d00-000000000001"
		outB   = "00000000-0000-4000-8d00-000000000002"
		whW    = "00000000-0000-4000-8d00-000000000003"
		adminU = "00000000-0000-4000-8d00-000000000011"
		mgrA   = "00000000-0000-4000-8d00-000000000012"
		custC  = "00000000-0000-4000-8d00-000000000021"
		catX   = "00000000-0000-4000-8d01-000000000001"
		catY   = "00000000-0000-4000-8d01-000000000002"
	)
	pid := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8d02-%012d", n) }
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'LP Outlet A'),($2,'LP Outlet B')`, outA, outB)
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'LP Gudang')`, whW)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
	  ($1,'lp-admin@example.invalid','x','LP Admin','admin',NULL),($2,'lp-mgr@example.invalid','x','LP Mgr','manager',$3)`, adminU, mgrA, outA)
	exec(`INSERT INTO customers(id,name,phone) VALUES($1,'Siti Pemegang Kode','0811000000')`, custC)
	exec(`INSERT INTO categories(id,name) VALUES($1,'LP Parfum'),($2,'LP Sabun')`, catX, catY)

	// Products. P1 Alpha: M low at A (1), L fine (10); P2 Beta inactive, no stock rows;
	// P3 Gamma: out at A (0); P4 a name with LIKE wildcards; P5 plain, plenty.
	type prod struct {
		n          int
		name, brnd string
		cat        string
		active     bool
		variants   [][4]any // size, sku, barcode, stock at A
	}
	for _, p := range []prod{
		{1, "Alpha Rose", "Mandalika", catX, true, [][4]any{{"M", "ALP-M", "8990001", 1}, {"L", "ALP-L", "8990002", 10}}},
		{2, "Beta Oud", "Mandalika", catY, false, [][4]any{{"M", "BET-M", "8990003", nil}}},
		{3, "Gamma Musk", "Flamboyan", catX, true, [][4]any{{"M", "GAM-M", "8990004", 0}}},
		{4, "100%_Promo Set", "Mandalika", catY, true, [][4]any{{"M", "PRO-M", "8990005", 5}}},
		{5, "Delta Citrus", "Mandalika", catX, true, [][4]any{{"M", "DEL-M", "8990006", 9}}},
	} {
		exec(`INSERT INTO products(id,name,brand,category_id,is_active,created_at) VALUES($1,$2,$3,$4,$5,'2026-10-01T00:00:00Z'::timestamptz + $6 * interval '1 day')`,
			pid(p.n), p.name, p.brnd, p.cat, p.active, p.n)
		for _, v := range p.variants {
			exec(`INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES($1,$2,1000,$3,$4)`, pid(p.n), v[0], v[1], v[2])
			if v[3] != nil {
				exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, outA, pid(p.n), v[0], v[3])
			}
		}
	}
	// B holds more of Alpha M, so the cross-outlet sum (1 + 4 = 5) is no longer low while A alone is.
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',4)`, outB, pid(1))

	rd := read.New(pool)
	h := New(rd, nil, nil, nil, nil, nil, nil)
	secret := []byte("LP-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string, perms ...string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokAdmin := issue(adminU, "admin", "", "manage_inventory", "manage_stock_count", "manage_promotions")
	tokMgrA := issue(mgrA, "manager", outA, "manage_inventory", "manage_stock_count")
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Get("/products", h.Products)
	router.Get("/promotions", h.Promotions)
	router.Get("/discount-codes", h.DiscountCodes)
	router.Get("/inventory/goods-receipts", h.ListGoodsReceipts)
	router.Get("/inventory/approvals", h.ListInventoryApprovals)
	router.Get("/users", h.ListUsers)
	router.Get("/error-logs", h.ErrorLogs)
	router.Get("/stock-counts", h.StockCounts)
	router.Get("/transfers", h.Transfers)
	router.Get("/ingredient-transfers", h.IngredientTransfers)
	router.Get("/ingredient-stock-counts", h.IngredientStockCounts)

	get := func(path, token string) (int, map[string]any) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		return w.Code, body
	}
	list := func(path, token string) (rows []map[string]any, total int, hasMeta bool) {
		t.Helper()
		code, body := get(path, token)
		if code != http.StatusOK {
			t.Fatalf("GET %s = %d %v", path, code, body)
		}
		for _, d := range body["data"].([]any) {
			rows = append(rows, d.(map[string]any))
		}
		if m, ok := body["meta"].(map[string]any); ok {
			return rows, int(m["total"].(float64)), true
		}
		return rows, len(rows), false
	}
	bad := func(path, token string) {
		t.Helper()
		if code, _ := get(path, token); code != http.StatusBadRequest {
			t.Fatalf("GET %s = %d, want 400", path, code)
		}
	}
	names := func(rows []map[string]any, key string) string {
		var out []string
		for _, r := range rows {
			out = append(out, fmt.Sprint(r[key]))
		}
		return strings.Join(out, "|")
	}

	t.Run("1 products: no parameter keeps the list and its order", func(t *testing.T) {
		rows, total, _ := list("/products", tokAdmin)
		if total != 5 || names(rows, "name") != "Delta Citrus|100%_Promo Set|Gamma Musk|Beta Oud|Alpha Rose" {
			t.Fatalf("unfiltered: total %d %s", total, names(rows, "name"))
		}
	})
	t.Run("2 products: q matches name, brand, SKU and barcode, and escapes LIKE wildcards", func(t *testing.T) {
		for q, want := range map[string]string{
			"alpha": "Alpha Rose", "flamboy": "Gamma Musk", "del-m": "Delta Citrus", "8990004": "Gamma Musk", "100%25": "100%_Promo Set",
		} {
			rows, _, _ := list("/products?q="+q, tokAdmin)
			if names(rows, "name") != want {
				t.Errorf("q=%s -> %s, want %s", q, names(rows, "name"), want)
			}
		}
		if rows, _, _ := list("/products?q=%25_x", tokAdmin); len(rows) != 0 {
			t.Errorf("a bare %%_x must not wildcard-match, got %s", names(rows, "name"))
		}
		if rows, total, _ := list("/products?q=mandalika", tokAdmin); total != 4 || len(rows) != 4 {
			t.Errorf("brand match: total %d rows %d, want 4", total, len(rows))
		}
	})
	t.Run("3 products: categoryId, active, sort and paging meta", func(t *testing.T) {
		if rows, total, _ := list("/products?categoryId="+catX, tokAdmin); total != 3 || len(rows) != 3 {
			t.Errorf("category X: total %d", total)
		}
		if rows, _, _ := list("/products?active=false", tokAdmin); names(rows, "name") != "Beta Oud" {
			t.Errorf("inactive: %s", names(rows, "name"))
		}
		if rows, total, _ := list("/products?active=true", tokAdmin); total != 4 || len(rows) != 4 {
			t.Errorf("active: total %d", total)
		}
		rows, _, _ := list("/products?sort=nama", tokAdmin)
		if names(rows, "name") != "100%_Promo Set|Alpha Rose|Beta Oud|Delta Citrus|Gamma Musk" {
			t.Errorf("sort=nama: %s", names(rows, "name"))
		}
		rows, total, _ := list("/products?sort=nama&limit=2&page=2", tokAdmin)
		if total != 5 || names(rows, "name") != "Beta Oud|Delta Citrus" {
			t.Errorf("page 2: total %d %s", total, names(rows, "name"))
		}
		if rows, total, _ := list("/products?active=true&categoryId="+catX+"&q=a&limit=1", tokAdmin); total != 3 || len(rows) != 1 {
			t.Errorf("combined filters: total %d rows %d", total, len(rows))
		}
	})
	t.Run("4 products: stock low/out follows the scoped outlet, or the sum over outlets", func(t *testing.T) {
		if rows, _, _ := list("/products?stock=low&outletId="+outA, tokAdmin); names(rows, "name") != "Alpha Rose" {
			t.Errorf("low at A: %s", names(rows, "name"))
		}
		// Beta has no stock row (0 at A) and its variant is active: out, like Gamma.
		if rows, _, _ := list("/products?stock=out&outletId="+outA+"&sort=nama", tokAdmin); names(rows, "name") != "Beta Oud|Gamma Musk" {
			t.Errorf("out at A: %s", names(rows, "name"))
		}
		if rows, _, _ := list("/products?stock=low&outletId=all", tokAdmin); len(rows) != 0 {
			t.Errorf("cross-outlet sum 5 is not low, got %s", names(rows, "name"))
		}
		if rows, _, _ := list("/products?stock=low", tokMgrA); names(rows, "name") != "Alpha Rose" {
			t.Errorf("manager (scoped to A): %s", names(rows, "name"))
		}
	})
	t.Run("5 products: invalid parameters answer 400", func(t *testing.T) {
		for _, q := range []string{"stock=few", "sort=price", "active=maybe", "categoryId=nope", "q=" + strings.Repeat("x", 101)} {
			bad("/products?"+q, tokAdmin)
		}
	})

	// Promotions and codes: one of each derived status. The day columns are relative to the
	// Asia/Jakarta business day so the test does not depend on when it runs.
	today := `(now() AT TIME ZONE 'Asia/Jakarta')::date`
	type promo struct {
		name, typ, start, end string
		active                bool
	}
	for i, p := range []promo{
		{"Promo Aktif Terbuka", "percentage", "NULL", "NULL", true},
		{"Promo Aktif Sampai Hari Ini", "fixed", today + " - 5", today, true},
		{"Promo Terjadwal Besok", "percentage", today + " + 1", "NULL", true},
		{"Promo Berakhir Kemarin", "fixed", "NULL", today + " - 1", true},
		{"Promo Nonaktif", "percentage", "NULL", "NULL", false},
		{"Promo Nonaktif Kadaluarsa", "percentage", "NULL", today + " - 9", false},
	} {
		exec(fmt.Sprintf(`INSERT INTO promotions(name,type,value,is_active,start_date,end_date,created_at)
		  VALUES($1,$2,10,$3,%s,%s,'2026-10-01T00:00:00Z'::timestamptz + $4 * interval '1 hour')`, p.start, p.end), p.name, p.typ, p.active, i)
	}
	t.Run("6 promotions: without page the whole list and no meta; with page a meta", func(t *testing.T) {
		rows, total, hasMeta := list("/promotions", tokAdmin)
		if hasMeta || total != 6 || len(rows) != 6 {
			t.Fatalf("full list: meta %v total %d", hasMeta, total)
		}
		rows, total, hasMeta = list("/promotions?page=2&limit=4", tokAdmin)
		if !hasMeta || total != 6 || len(rows) != 2 {
			t.Fatalf("page 2: meta %v total %d rows %d", hasMeta, total, len(rows))
		}
		rows, total, _ = list("/promotions?page=9&limit=4", tokAdmin)
		if total != 6 || len(rows) != 0 {
			t.Fatalf("past the end keeps the total: total %d rows %d", total, len(rows))
		}
	})
	t.Run("7 promotions: status uses the Jakarta business day and the badge precedence", func(t *testing.T) {
		for st, want := range map[string]string{
			"aktif":     "Promo Aktif Sampai Hari Ini|Promo Aktif Terbuka",
			"terjadwal": "Promo Terjadwal Besok",
			"berakhir":  "Promo Berakhir Kemarin",
			"nonaktif":  "Promo Nonaktif Kadaluarsa|Promo Nonaktif",
		} {
			rows, total, hasMeta := list("/promotions?status="+st, tokAdmin)
			if names(rows, "name") != want || hasMeta || total != len(rows) {
				t.Errorf("status=%s -> %s (meta %v), want %s", st, names(rows, "name"), hasMeta, want)
			}
		}
		if rows, total, _ := list("/promotions?status=nonaktif&page=1&limit=1", tokAdmin); total != 2 || len(rows) != 1 {
			t.Errorf("paged status: total %d rows %d", total, len(rows))
		}
	})
	t.Run("8 promotions: q and type", func(t *testing.T) {
		if rows, _, _ := list("/promotions?q=besok", tokAdmin); names(rows, "name") != "Promo Terjadwal Besok" {
			t.Errorf("q: %s", names(rows, "name"))
		}
		if rows, total, _ := list("/promotions?type=fixed&page=1", tokAdmin); total != 2 || len(rows) != 2 {
			t.Errorf("type: total %d", total)
		}
		bad("/promotions?status=expired", tokAdmin)
	})

	for i, c := range []struct {
		code, typ, start, end string
		active                bool
		customer              any
	}{
		{"KODE-AKTIF", "percentage", "NULL", "NULL", true, nil},
		{"KODE-BESOK", "fixed", today + " + 2", "NULL", true, nil},
		{"KODE-LEWAT", "fixed", "NULL", today + " - 3", true, nil},
		{"KODE-MATI", "percentage", "NULL", "NULL", false, nil},
		{"KODE-SITI", "percentage", "NULL", "NULL", true, custC},
	} {
		exec(fmt.Sprintf(`INSERT INTO discount_codes(code,type,value,is_active,start_date,end_date,customer_id,created_at)
		  VALUES($1,$2,10,$3,%s,%s,$4,'2026-10-01T00:00:00Z'::timestamptz + $5 * interval '1 hour')`, c.start, c.end), c.code, c.typ, c.active, c.customer, i)
	}
	t.Run("9 discount codes: full list, paging, status, type, q (code and holder name)", func(t *testing.T) {
		if rows, total, hasMeta := list("/discount-codes", tokAdmin); hasMeta || total != 5 || len(rows) != 5 {
			t.Fatalf("full list: meta %v total %d", hasMeta, total)
		}
		if rows, total, hasMeta := list("/discount-codes?page=1&limit=2", tokAdmin); !hasMeta || total != 5 || len(rows) != 2 {
			t.Fatalf("paged: meta %v total %d rows %d", hasMeta, total, len(rows))
		}
		for st, want := range map[string]string{"aktif": "KODE-SITI|KODE-AKTIF", "terjadwal": "KODE-BESOK", "berakhir": "KODE-LEWAT", "nonaktif": "KODE-MATI"} {
			if rows, _, _ := list("/discount-codes?status="+st, tokAdmin); names(rows, "code") != want {
				t.Errorf("status=%s -> %s, want %s", st, names(rows, "code"), want)
			}
		}
		if rows, _, _ := list("/discount-codes?q=pemegang", tokAdmin); names(rows, "code") != "KODE-SITI" {
			t.Errorf("q by holder name: %s", names(rows, "code"))
		}
		if rows, _, _ := list("/discount-codes?q=kode-b&type=fixed", tokAdmin); names(rows, "code") != "KODE-BESOK" {
			t.Errorf("q + type: %s", names(rows, "code"))
		}
		// The holder's name stays hidden from a caller without manage_promotions, filtered or not.
		tokNoPromo := issue(mgrA, "manager", outA, "manage_inventory")
		rows, _, _ := list("/discount-codes?q=kode-s&page=1", tokNoPromo)
		if len(rows) != 1 || rows[0]["customerName"] != nil {
			t.Errorf("customer name must be hidden: %v", rows)
		}
		if rows, _, _ := list("/discount-codes?q=pemegang&page=1", tokNoPromo); len(rows) != 0 {
			t.Errorf("the holder name must not be searchable without manage_promotions: %v", rows)
		}
		bad("/discount-codes?status=expired", tokAdmin)
	})

	t.Run("10 erp outbox: locationName from the outlet, the warehouse, or null once deleted", func(t *testing.T) {
		const gone = "00000000-0000-4000-8d03-000000000009"
		for i, l := range [][2]string{{"outlet", outA}, {"warehouse", whW}, {"outlet", gone}} {
			exec(`INSERT INTO erp_outbox(document_id,doc_key,kind,location_type,location_id,ref_type,ref_id)
			  VALUES(gen_random_uuid(),$1,'receipt',$2,$3,'goods_receipt',gen_random_uuid())`, fmt.Sprintf("lp:%d", i), l[0], l[1])
		}
		items, total, err := erp.List(ctx, pool, "", "", 50, 0)
		if err != nil || total != 3 {
			t.Fatalf("list: %v total %d", err, total)
		}
		got := map[string]string{}
		for _, it := range items {
			name := "<nil>"
			if it.LocationName != nil {
				name = *it.LocationName
			}
			got[it.LocationID] = name
			b, _ := json.Marshal(itemToAPI(it))
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if (it.LocationName == nil) != (m["locationName"] == nil) {
				t.Errorf("json locationName %v for %v", m["locationName"], it.LocationName)
			}
		}
		if got[outA] != "LP Outlet A" || got[whW] != "LP Gudang" || got[gone] != "<nil>" {
			t.Errorf("location names: %v", got)
		}
		for _, it := range items {
			d, err := erp.Get(ctx, pool, it.ID)
			if err != nil || (d.LocationName == nil) != (it.LocationName == nil) {
				t.Errorf("detail %s location name: %v %v", it.ID, err, d.LocationName)
			}
		}
	})

	// Goods receipts: A (outlet), B (outlet), warehouse W; one a warranty receipt.
	receipt := func(loc string, isWh bool, supplier, note, source, at string, items ...[3]any) {
		var id string
		col := "outlet_id"
		if isWh {
			col = "warehouse_id"
		}
		if err := pool.QueryRow(ctx, fmt.Sprintf(`INSERT INTO goods_receipts(%s,supplier,note,source,created_by,created_at)
		  VALUES($1,$2,$3,$4,$5,$6::timestamptz) RETURNING id::text`, col), loc, supplier, note, source, adminU, at).Scan(&id); err != nil {
			t.Fatal(err)
		}
		for _, it := range items {
			exec(`INSERT INTO goods_receipt_items(receipt_id,product_id,variant_size,qty) VALUES($1,$2,$3,$4)`, id, it[0], it[1], it[2])
		}
	}
	receipt(outA, false, "PT Sumber", "kirim pagi", "supply", "2026-10-10T03:00:00Z", [3]any{pid(1), "M", 6}, [3]any{pid(1), "L", 4})
	receipt(outB, false, "CV Lain", "", "supply", "2026-10-11T03:00:00Z", [3]any{pid(5), "M", 2})
	receipt(whW, true, "PT Sumber", "gudang", "supply", "2026-10-12T03:00:00Z", [3]any{pid(3), "M", 7})
	receipt(outA, false, "Garansi Toko", "ganti rusak", "warranty", "2026-10-13T03:00:00Z", [3]any{pid(3), "M", 1})
	t.Run("11 goods receipts: scope, filters, paging", func(t *testing.T) {
		rows, total, hasMeta := list("/inventory/goods-receipts", tokAdmin)
		if !hasMeta || total != 4 || names(rows, "supplier") != "Garansi Toko|PT Sumber|CV Lain|PT Sumber" {
			t.Fatalf("admin (cross-outlet): total %d %s", total, names(rows, "supplier"))
		}
		if rows[3]["lineCount"].(float64) != 2 || rows[3]["totalQty"].(float64) != 10 || rows[3]["locationName"] != "LP Outlet A" || rows[3]["createdByName"] != "LP Admin" {
			t.Errorf("aggregates: %v", rows[3])
		}
		// A manager of outlet A never sees B's receipt but does see the warehouse's.
		if rows, total, _ := list("/inventory/goods-receipts", tokMgrA); total != 3 || strings.Contains(names(rows, "supplier"), "CV Lain") {
			t.Errorf("manager A: total %d %s", total, names(rows, "supplier"))
		}
		if rows, _, _ := list("/inventory/goods-receipts?locationType=warehouse", tokAdmin); names(rows, "locationName") != "LP Gudang" {
			t.Errorf("locationType: %s", names(rows, "locationName"))
		}
		if rows, _, _ := list("/inventory/goods-receipts?locationType=outlet&locationId="+outB, tokAdmin); names(rows, "supplier") != "CV Lain" {
			t.Errorf("location: %s", names(rows, "supplier"))
		}
		if rows, _, _ := list("/inventory/goods-receipts?source=warranty", tokAdmin); names(rows, "supplier") != "Garansi Toko" {
			t.Errorf("source: %s", names(rows, "supplier"))
		}
		if rows, _, _ := list("/inventory/goods-receipts?q=ganti", tokAdmin); names(rows, "supplier") != "Garansi Toko" {
			t.Errorf("q by note: %s", names(rows, "supplier"))
		}
		if rows, _, _ := list("/inventory/goods-receipts?q=gam-m", tokAdmin); names(rows, "supplier") != "Garansi Toko|PT Sumber" {
			t.Errorf("q by item SKU: %s", names(rows, "supplier"))
		}
		// A day is read in Asia/Jakarta: 03:00Z on the 11th is 10:00 WIB on the 11th.
		if rows, _, _ := list("/inventory/goods-receipts?dari=2026-10-11&sampai=2026-10-12", tokAdmin); names(rows, "supplier") != "PT Sumber|CV Lain" {
			t.Errorf("dari/sampai: %s", names(rows, "supplier"))
		}
		rows, total, _ = list("/inventory/goods-receipts?limit=3&page=2", tokAdmin)
		if total != 4 || len(rows) != 1 {
			t.Errorf("page 2: total %d rows %d", total, len(rows))
		}
		if _, total, _ = list("/inventory/goods-receipts?limit=3&page=5", tokAdmin); total != 4 {
			t.Errorf("past the end total %d", total)
		}
		for _, q := range []string{"locationType=shelf", "locationId=" + outA, "locationType=outlet&locationId=zzz", "source=gift", "dari=kemarin"} {
			bad("/inventory/goods-receipts?"+q, tokAdmin)
		}
	})

	// Approvals: a pending adjustment at A and one at the warehouse, a pending count at A.
	exec(`INSERT INTO stock_adjustment_requests(number,outlet_id,product_id,variant_size,qty_at_request,requested_new_qty,reason_code,requested_by)
	  VALUES('ADJ-LP-1',$1,$2,'M',1,0,'damaged',$3)`, outA, pid(1), mgrA)
	exec(`INSERT INTO stock_adjustment_requests(number,warehouse_id,product_id,variant_size,qty_at_request,requested_new_qty,reason_code,requested_by)
	  VALUES('ADJ-LP-2',$1,$2,'M',7,6,'lost',$3)`, whW, pid(1), mgrA)
	exec(`INSERT INTO stock_counts(name,status,outlet_id,submitted_by,submitted_at) VALUES('Opname LP','pending_approval',$1,$2,now())`, outA, mgrA)
	t.Run("12 approvals: outletId and kind narrow the list but not pendingCount", func(t *testing.T) {
		code, body := get("/inventory/approvals", tokAdmin)
		if code != 200 || body["pendingCount"].(float64) != 3 {
			t.Fatalf("unfiltered: %d %v", code, body["pendingCount"])
		}
		// An admin's outletId also switches the scope, which shrinks what counts as pending.
		check := func(path string, wantTotal int, wantKinds string, wantPending ...int) {
			pending := 3
			if len(wantPending) > 0 {
				pending = wantPending[0]
			}
			t.Helper()
			rows, total, _ := list(path, tokAdmin)
			var kinds []string
			for _, r := range rows {
				kinds = append(kinds, r["type"].(string))
			}
			_, b := get(path, tokAdmin)
			if total != wantTotal || strings.Join(kinds, "|") != wantKinds || b["pendingCount"].(float64) != float64(pending) {
				t.Errorf("%s: total %d kinds %v pendingCount %v", path, total, kinds, b["pendingCount"])
			}
		}
		check("/inventory/approvals?kind=count", 1, "count")
		check("/inventory/approvals?kind=adjustment", 2, "adjustment|adjustment")
		check("/inventory/approvals?outletId="+outA, 2, "adjustment|count", 3)
		check("/inventory/approvals?outletId="+outA+"&kind=count", 1, "count", 3)
		check("/inventory/approvals?outletId=all", 3, "adjustment|adjustment|count")
		check("/inventory/approvals?outletId="+outB, 0, "", 1)
		bad("/inventory/approvals?kind=transfer", tokAdmin)
		bad("/inventory/approvals?outletId=zzz", tokMgrA)
	})

	t.Run("13 stable paging: rows with an identical created_at never repeat or vanish across pages", func(t *testing.T) {
		for i := 0; i < 7; i++ {
			exec(`INSERT INTO users(email,password_hash,display_name,role,created_at) VALUES($1,'x',$2,'cashier','2026-01-01T00:00:00Z')`,
				fmt.Sprintf("lp-tie-%d@example.invalid", i), fmt.Sprintf("Tie %d", i))
			exec(`INSERT INTO error_logs(source,message,created_at) VALUES('runtime',$1,now() - interval '2 days')`, fmt.Sprintf("tie-%d", i))
		}
		for _, c := range []struct {
			path string
			want int
		}{{"/users", 7 + 2}, {"/error-logs", 7}} {
			seen := map[string]int{}
			for page := 1; page <= 5; page++ {
				rows, _, _ := list(fmt.Sprintf("%s?limit=3&page=%d", c.path, page), tokAdmin)
				for _, r := range rows {
					seen[fmt.Sprint(r["id"])]++
				}
			}
			dups := 0
			for _, n := range seen {
				if n > 1 {
					dups++
				}
			}
			if len(seen) != c.want || dups != 0 {
				t.Errorf("%s: %d distinct rows (want %d), %d repeated", c.path, len(seen), c.want, dups)
			}
		}
		// The other paged lists only need to keep running with their new ORDER BY.
		for _, path := range []string{"/stock-counts", "/transfers", "/ingredient-transfers", "/ingredient-stock-counts"} {
			if code, body := get(path+"?limit=2&page=2", tokAdmin); code != http.StatusOK {
				t.Errorf("%s = %d %v", path, code, body)
			}
		}
	})
}
