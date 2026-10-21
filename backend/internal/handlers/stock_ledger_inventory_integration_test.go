package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/ledger"
	"github.com/mandalika/pos-backend/internal/write"
)

const slInvUser = "00000000-0000-4000-8f67-0000000000e1"

// slInventory drives goods receipts and absolute adjusts through the real handlers and
// repo: ledger rows land in the writer's transaction (exact before/after), a keyed replay
// adds none, a reused key with another body is a 409, and stock_movements always sums to
// live stock (plan §2.3 rows 6-7, §3.1).
func slInventory(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	one := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	str := func(sql string, args ...any) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL warehouse') ON CONFLICT DO NOTHING`, slWarehouse)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'in-adj',10)
	      ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock = 10`, slOutletA, slProductP)
	exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'in-wh',8)
	      ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock = 8`, slWarehouse, slProductQ)
	slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: "inv-open"})
	assertLedgerInvariant(t, ctx, pool)

	h := &Handlers{Write: write.New(pool)}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), auth.CtxUserID, slInvUser)))
		})
	})
	router.Post("/inventory/goods-receipt", h.CreateLocationGoodsReceipt)
	router.Post("/inventory/adjust", h.AdjustLocationStock)
	post := func(path, kind, id, key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path+"?kind="+kind+"&id="+id, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	wantOK := func(w *httptest.ResponseRecorder, what string) string {
		t.Helper()
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	total := func() int { return slCount(t, ctx, pool, `true`) }
	seq := func() int { return one(`SELECT seq::int FROM outlet_stock_seq WHERE outlet_id=$1`, slOutletA) }
	outStock := func(p, size string) int {
		return one(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, slOutletA, p, size)
	}
	whStock := func(p, size string) int {
		return one(`SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`, slWarehouse, p, size)
	}
	lastReceipt := func(col, loc string) string {
		return str(`SELECT id::text FROM goods_receipts WHERE `+col+`=$1 ORDER BY created_at DESC LIMIT 1`, loc)
	}
	lastAdjust := func(col, loc string) string {
		return str(`SELECT id::text FROM warehouse_stock_adjustments WHERE `+col+`=$1 ORDER BY created_at DESC LIMIT 1`, loc)
	}
	line := func(p, size string, qty int) string {
		return `{"productId":"` + p + `","variantSize":"` + size + `","qty":` + strconv.Itoa(qty) + `}`
	}

	// outlet receipt: the same (product,size) twice is ONE summed row; exact before/after
	body := `{"supplier":"CV Uji","items":[` + line(slProductP, "in-r1", 2) + `,` + line(slProductQ, "in-r2", 5) + `,` + line(slProductP, "in-r1", 3) + `]}`
	seq0, receipts0 := seq(), one(`SELECT count(*)::int FROM goods_receipts WHERE outlet_id=$1`, slOutletA)
	first := wantOK(post("/inventory/goods-receipt", "outlet", slOutletA, "sl-gr-1", body), "outlet receipt")
	rid := lastReceipt("outlet_id", slOutletA)
	want := []slMovement{
		{slProductP, "in-r1", 5, 0, 5, "outlet", slOutletA, "", []string{}},
		{slProductQ, "in-r2", 5, 0, 5, "outlet", slOutletA, "", []string{}},
	}
	if got := slMovements(t, ctx, pool, "receipt", rid); !reflect.DeepEqual(sortMovements(got), sortMovements(want)) {
		t.Fatalf("receipt rows = %+v, want %+v", got, want)
	}
	if one(`SELECT count(*)::int FROM goods_receipts WHERE outlet_id=$1`, slOutletA) != receipts0+1 || seq() != seq0+1 ||
		slCount(t, ctx, pool, `ref_id=$1 AND ref_type='goods_receipt' AND actor=$2`, rid, slInvUser) != 2 {
		t.Fatalf("one receipt, one stock seq bump and the caller as actor expected (seq %d -> %d)", seq0, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// same key + same body: same answer, nothing written
	before, seq1 := total(), seq()
	if again := wantOK(post("/inventory/goods-receipt", "outlet", slOutletA, "sl-gr-1", body), "receipt replay"); again != first ||
		total() != before || seq() != seq1 || one(`SELECT count(*)::int FROM goods_receipts WHERE outlet_id=$1`, slOutletA) != receipts0+1 {
		t.Fatalf("a keyed replay must change nothing (movements %d -> %d)", before, total())
	}
	// same key, other body or other location: 409, nothing written
	other := `{"items":[` + line(slProductP, "in-r1", 1) + `]}`
	if w := post("/inventory/goods-receipt", "outlet", slOutletA, "sl-gr-1", other); w.Code != http.StatusConflict {
		t.Fatalf("key reuse with another body: %d, want 409", w.Code)
	}
	if w := post("/inventory/goods-receipt", "warehouse", slWarehouse, "sl-gr-1", body); w.Code != http.StatusConflict {
		t.Fatalf("key reuse for another location: %d, want 409", w.Code)
	}
	if total() != before || outStock(slProductP, "in-r1") != 5 || seq() != seq1 {
		t.Fatal("a key conflict must write nothing (rows, stock, stock seq)")
	}
	assertLedgerInvariant(t, ctx, pool)

	// warehouse receipt (keyed): rows at the warehouse, the outlet stock seq untouched
	seq2 := seq()
	wantOK(post("/inventory/goods-receipt", "warehouse", slWarehouse, "sl-gr-2", `{"items":[`+line(slProductQ, "in-wh", 4)+`]}`), "warehouse receipt")
	wrid := lastReceipt("warehouse_id", slWarehouse)
	wantW := []slMovement{{slProductQ, "in-wh", 4, 8, 12, "warehouse", slWarehouse, "", []string{}}}
	if got := slMovements(t, ctx, pool, "receipt", wrid); !reflect.DeepEqual(got, wantW) || seq() != seq2 || whStock(slProductQ, "in-wh") != 12 {
		t.Fatalf("warehouse receipt rows = %+v seq %d -> %d", got, seq2, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// unkeyed outlet receipt with an UPPERCASE product id: still 200, canonical ledger row
	seqU := seq()
	wantOK(post("/inventory/goods-receipt", "outlet", slOutletA, "", `{"items":[`+line(strings.ToUpper(slProductP), "in-up", 6)+`]}`), "uppercase receipt")
	wantU := []slMovement{{slProductP, "in-up", 6, 0, 6, "outlet", slOutletA, "", []string{}}}
	if got := slMovements(t, ctx, pool, "receipt", lastReceipt("outlet_id", slOutletA)); !reflect.DeepEqual(got, wantU) || seq() != seqU+1 {
		t.Fatalf("unkeyed uppercase receipt rows = %+v seq %d -> %d", got, seqU, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// outlet adjust, existing key 10 -> 4 (unkeyed path): one adjust row of -6
	seq3 := seq()
	wantOK(post("/inventory/adjust", "outlet", slOutletA, "", `{"productId":"`+slProductP+`","variantSize":"in-adj","newQty":4,"reason":"hitung ulang"}`), "adjust 10->4")
	aid := lastAdjust("outlet_id", slOutletA)
	wantA := []slMovement{{slProductP, "in-adj", -6, 10, 4, "outlet", slOutletA, "", []string{}}}
	if got := slMovements(t, ctx, pool, "adjust", aid); !reflect.DeepEqual(got, wantA) || seq() != seq3+1 {
		t.Fatalf("adjust rows = %+v seq %d -> %d", got, seq3, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// missing key -> 7: a stock row appears and the ledger row is +7 (0 -> 7)
	seqM := seq()
	newBody := `{"productId":"` + slProductQ + `","variantSize":"in-new","newQty":7,"reason":"stok awal"}`
	wantOK(post("/inventory/adjust", "outlet", slOutletA, "sl-adj-new", newBody), "adjust missing")
	if seq() != seqM+1 {
		t.Fatalf("adjust of a missing row must bump the stock seq once (%d -> %d)", seqM, seq())
	}
	nid := lastAdjust("outlet_id", slOutletA)
	wantN := []slMovement{{slProductQ, "in-new", 7, 0, 7, "outlet", slOutletA, "", []string{}}}
	if got := slMovements(t, ctx, pool, "adjust", nid); !reflect.DeepEqual(got, wantN) || outStock(slProductQ, "in-new") != 7 {
		t.Fatalf("adjust of a missing row = %+v", got)
	}
	// keyed outlet adjust replay: no rows, no stock seq bump
	before, seqR := total(), seq()
	wantOK(post("/inventory/adjust", "outlet", slOutletA, "sl-adj-new", newBody), "outlet adjust replay")
	if total() != before || seq() != seqR {
		t.Fatalf("outlet adjust replay wrote rows or bumped the seq (%d -> %d)", seqR, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// no-op adjust (4 -> 4): the correction is logged but no movement row is written
	before = total()
	wantOK(post("/inventory/adjust", "outlet", slOutletA, "", `{"productId":"`+slProductP+`","variantSize":"in-adj","newQty":4,"reason":"cek"}`), "adjust no-op")
	if total() != before || slCount(t, ctx, pool, `kind='adjust' AND ref_id=$1`, lastAdjust("outlet_id", slOutletA)) != 0 {
		t.Fatalf("a no-op adjust wrote %d movements", total()-before)
	}
	assertLedgerInvariant(t, ctx, pool)

	// warehouse adjust 12 -> 3
	seq4 := seq()
	wantOK(post("/inventory/adjust", "warehouse", slWarehouse, "sl-adj-wh", `{"productId":"`+slProductQ+`","variantSize":"in-wh","newQty":3,"reason":"rusak"}`), "warehouse adjust")
	wantWA := []slMovement{{slProductQ, "in-wh", -9, 12, 3, "warehouse", slWarehouse, "", []string{}}}
	if got := slMovements(t, ctx, pool, "adjust", lastAdjust("warehouse_id", slWarehouse)); !reflect.DeepEqual(got, wantWA) || seq() != seq4 {
		t.Fatalf("warehouse adjust = %+v seq %d -> %d", got, seq4, seq())
	}
	assertLedgerInvariant(t, ctx, pool)

	// keyed adjust replay adds nothing; another body under the same key is a 409
	adjBody := `{"productId":"` + slProductQ + `","variantSize":"in-wh","newQty":3,"reason":"rusak"}`
	before, adjusts, seqC := total(), one(`SELECT count(*)::int FROM warehouse_stock_adjustments`), seq()
	wantOK(post("/inventory/adjust", "warehouse", slWarehouse, "sl-adj-wh", adjBody), "adjust replay")
	if total() != before || one(`SELECT count(*)::int FROM warehouse_stock_adjustments`) != adjusts {
		t.Fatalf("adjust replay wrote rows (movements %d -> %d)", before, total())
	}
	if w := post("/inventory/adjust", "warehouse", slWarehouse, "sl-adj-wh", strings.Replace(adjBody, `"newQty":3`, `"newQty":9`, 1)); w.Code != http.StatusConflict ||
		total() != before || whStock(slProductQ, "in-wh") != 3 || seq() != seqC {
		t.Fatalf("adjust key reuse with another body: %d, want 409 and no writes", w.Code)
	}
	assertLedgerInvariant(t, ctx, pool)
}
