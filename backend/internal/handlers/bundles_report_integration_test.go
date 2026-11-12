package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/bundles"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
)

// Bundles phase 5: the bundle sales report and item sales at their share. Called from
// bundleSaleSubtests (which owns the fixture). Earlier subtests already left bundle sales, so
// every assertion is a delta against a baseline taken first.
func bundleReportSubtests(
	t *testing.T, pool *pgxpool.Pool, ctx context.Context, rd *read.Repo, h *Handlers, secret []byte,
	outlet, champ, swapP string,
	call func(method, path string, headers map[string]string, body any) (int, map[string]any, string),
	bundleItems func(string, float64, float64) []map[string]any,
	sale func([]map[string]any, float64) map[string]any,
	syncSale func(map[string]any) map[string]any,
	orderID func(map[string]any) string,
	exec func(string, ...any),
) {
	const (
		outlet2 = "00000000-0000-4000-8f00-0000000000e2"
		user    = "00000000-0000-4000-8f00-000000000021"
		piFull  = "120ml PARFUM INTENSE"
		atom    = "10ml ATOMIZER"
		vialPI  = "2ml PARFUM INTENSE"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'BN Outlet 2')`, outlet2)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,100)`, outlet, champ, piFull)
	exec(`UPDATE promotions SET is_active=false`)

	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.With(mw.RequirePermission("view_reports")).Get("/bundle-report", h.BundleReport)
	report := func(role, outletID string, perms []string, query string) (int, api.BundleReport) {
		t.Helper()
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outletID, perms)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "/bundle-report"+query, nil)
		r.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out api.BundleReport
		if w.Code == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatalf("decode %s: %v", w.Body.String(), err)
			}
		}
		return w.Code, out
	}
	admin := func(query string) api.BundleReport {
		t.Helper()
		code, out := report("admin", "", []string{"view_reports"}, query)
		if code != 200 {
			t.Fatalf("report %d", code)
		}
		return out
	}
	rowOf := func(r api.BundleReport, pid, line, size string) api.BundleReportRow {
		for _, x := range r.Data {
			if x.ProductId.String() == pid && x.Line == line && x.Size == size {
				return x
			}
		}
		return api.BundleReportRow{}
	}
	piItems := func() []map[string]any {
		// PI 120ml basis [1100000, 250000, 55000], standard price 795000
		sh, err := bundles.Split(795000, [3]int64{1100000, 250000, 55000})
		if err != nil {
			t.Fatal(err)
		}
		mk := func(role, size string, price int64, basis float64) map[string]any {
			return map[string]any{
				"productId": champ, "productName": "CHAMPION", "variantSize": size, "price": float64(price), "quantity": 1,
				"subtotal": float64(price), "bundleGroup": 1, "bundleRole": role, "bundlePrice": 795000.0, "bundleBasisPrice": basis,
			}
		}
		return []map[string]any{mk("large", piFull, sh[0], 1100000), mk("atomizer", atom, sh[1], 250000), mk("vial", vialPI, sh[2], 55000)}
	}

	t.Run("bundle_report_counts", func(t *testing.T) {
		base := admin("")
		extBase := rowOf(base, champ, "EXTRAIT DE PARFUM", "120ml")
		piBase := rowOf(base, champ, "PARFUM INTENSE", "120ml")
		for i := 0; i < 2; i++ {
			syncSale(sale(bundleItems(champ, 250000, 850000), 850000))
		}
		syncSale(sale(piItems(), 795000))
		refunded := sale(bundleItems(champ, 250000, 850000), 850000)
		syncSale(refunded)
		code, _, raw := call("POST", "/orders/"+orderID(refunded)+"/refund", nil, map[string]any{"reason": "semua", "items": []map[string]int{
			{"lineNo": 0, "quantity": 1}, {"lineNo": 1, "quantity": 1}, {"lineNo": 2, "quantity": 1}}})
		if code != 201 {
			t.Fatalf("refund %d %s", code, raw)
		}
		got := admin("")
		ext, pi := rowOf(got, champ, "EXTRAIT DE PARFUM", "120ml"), rowOf(got, champ, "PARFUM INTENSE", "120ml")
		if ext.Bundles-extBase.Bundles != 2 || ext.Revenue-extBase.Revenue != 1700000 {
			t.Errorf("EXT 120ml delta bundles %d revenue %v, want 2 / 1700000", ext.Bundles-extBase.Bundles, ext.Revenue-extBase.Revenue)
		}
		if pi.Bundles-piBase.Bundles != 1 || pi.Revenue-piBase.Revenue != 795000 {
			t.Errorf("PI 120ml delta bundles %d revenue %v, want 1 / 795000", pi.Bundles-piBase.Bundles, pi.Revenue-piBase.Revenue)
		}
		if ext.ProductName != "CHAMPION" || ext.LineLabel != "Extrait" || pi.LineLabel != "Parfum Intense" {
			t.Errorf("labels: %+v %+v", ext, pi)
		}
		// Hand check: totals equal an independent SQL aggregate over the whole table.
		var nb int
		var rev, disc float64
		if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE i.bundle_role='large'), COALESCE(sum(i.subtotal),0), COALESCE(sum(i.bundle_discount),0)
		  FROM order_items i JOIN orders o ON o.id=i.order_id
		 WHERE i.bundle_group IS NOT NULL AND o.status IN ('completed','partially_refunded')
		   AND NOT EXISTS (SELECT 1 FROM order_refund_items ri JOIN order_items l ON l.id=ri.order_item_id
		                    WHERE l.order_id=i.order_id AND l.bundle_group=i.bundle_group)`).Scan(&nb, &rev, &disc); err != nil {
			t.Fatal(err)
		}
		if got.Totals.Bundles != nb || got.Totals.Revenue != rev || got.Totals.Discount != disc {
			t.Errorf("totals %+v, SQL says %d / %v / %v", got.Totals, nb, rev, disc)
		}
		// Date window with no sales, and a day in the future, are empty.
		if empty := admin("?dateFrom=2000-01-01&dateTo=2000-01-02"); len(empty.Data) != 0 || empty.Totals.Bundles != 0 {
			t.Errorf("old window not empty: %+v", empty)
		}
	})

	t.Run("bundle_report_outlet_scope", func(t *testing.T) {
		code, mine := report("manager", outlet, []string{"view_reports"}, "")
		if code != 200 || mine.Totals.Bundles == 0 {
			t.Fatalf("own outlet %d %+v", code, mine.Totals)
		}
		// A manager of another outlet never sees this outlet, even when asking for it by id.
		code, other := report("manager", outlet2, []string{"view_reports"}, "?outletId="+outlet)
		if code != 200 || other.Totals.Bundles != 0 || len(other.Data) != 0 {
			t.Errorf("outlet2 manager saw %d %+v", code, other.Totals)
		}
		// Admin picking outlet2 sees nothing; picking the sale outlet sees it.
		if a2 := admin("?outletId=" + outlet2); a2.Totals.Bundles != 0 {
			t.Errorf("admin outlet2: %+v", a2.Totals)
		}
		if a1 := admin("?outletId=" + outlet); a1.Totals.Bundles != mine.Totals.Bundles {
			t.Errorf("admin outlet1 %d vs manager %d", a1.Totals.Bundles, mine.Totals.Bundles)
		}
	})

	t.Run("bundle_report_no_outlet_fails_closed", func(t *testing.T) {
		if code, _ := report("manager", "", []string{"view_reports"}, ""); code != 403 {
			t.Errorf("non-admin with no outlet = %d, want 403", code)
		}
	})

	t.Run("bundle_report_bad_date", func(t *testing.T) {
		if code, _ := report("admin", "", []string{"view_reports"}, "?dateFrom=nope"); code != 400 {
			t.Errorf("bad date = %d, want 400", code)
		}
	})

	t.Run("bundle_report_forbidden", func(t *testing.T) {
		if code, _ := report("cashier", outlet, []string{"create_order"}, ""); code != 403 {
			t.Errorf("no view_reports = %d, want 403", code)
		}
	})

	t.Run("top_products_at_share", func(t *testing.T) {
		rev := func() (champRev, swapRev float64) {
			t.Helper()
			sm, err := rd.ReportSummary(ctx, read.OrderFilter{Scope: read.Scope{CrossAll: true}})
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range sm.TopProducts {
				switch p.ProductId {
				case champ:
					champRev = p.Revenue
				case swapP:
					swapRev = p.Revenue
				}
			}
			return
		}
		c0, s0 := rev()
		// atomizer swapped to product B: Split(850000, [1200000, 250000, 60000])
		syncSale(sale(bundleItems(swapP, 250000, 850000), 850000))
		c1, s1 := rev()
		if c1-c0 != 709272 || s1-s0 != 140728 {
			t.Errorf("champion +%v (want 709272 = 675498 + 33774), swapped atomizer +%v (want 140728)", c1-c0, s1-s0)
		}
	})
}
