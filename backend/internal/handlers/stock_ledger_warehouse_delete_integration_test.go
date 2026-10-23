package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/write"
)

// slDeleteWarehouseHistory: a warehouse whose stock rows are all zero but that a stock
// document names cannot be hard-deleted. Receipts, adjustments and stock counts (product
// and ingredient side) cascade from warehouses, so the delete used to erase them silently;
// transfers keep a plain foreign key, so it used to fail with the generic 400. Each now
// answers 409 naming the history and the supported alternative (deactivate the warehouse)
// and changes nothing. A warehouse with only zero stock rows and no documents still deletes.
func slDeleteWarehouseHistory(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	one := func(t *testing.T, sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const (
		pid   = "00000000-0000-4000-8f67-0000000000e0"
		ingID = "00000000-0000-4000-8f67-0000000000e1"
		other = "00000000-0000-4000-8f67-0000000000ef" // the far side of an ingredient transfer
	)
	exec(t, `INSERT INTO products(id,name) VALUES($1::uuid,'SL wh delete product') ON CONFLICT DO NOTHING`, pid)
	exec(t, `INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES($1::uuid,'50ml',100000,'SKU-WHDEL','BC-WHDEL')
	      ON CONFLICT DO NOTHING`, pid)
	exec(t, `INSERT INTO ingredients(id,name,unit) VALUES($1::uuid,'SL wh delete ingredient','ml') ON CONFLICT DO NOTHING`, ingID)
	exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'SL wh other') ON CONFLICT DO NOTHING`, other)

	repo := write.New(pool)
	h := &Handlers{Write: repo}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), auth.CtxUserID, slInvUser)))
		})
	})
	router.Post("/inventory/goods-receipt", h.CreateLocationGoodsReceipt)
	router.Post("/inventory/adjust", h.AdjustLocationStock)
	router.Delete("/warehouses/{id}", h.DeleteWarehouse)
	send := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	wantOK := func(t *testing.T, w *httptest.ResponseRecorder, what string) {
		t.Helper()
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
	}
	receipt := func(t *testing.T, wh string, qty int) {
		t.Helper()
		wantOK(t, send(http.MethodPost, "/inventory/goods-receipt?kind=warehouse&id="+wh,
			`{"supplier":"CV Uji","items":[{"productId":"`+pid+`","variantSize":"50ml","qty":`+strconv.Itoa(qty)+`}]}`), "receipt")
	}
	adjust := func(t *testing.T, wh string, qty int) {
		t.Helper()
		wantOK(t, send(http.MethodPost, "/inventory/adjust?kind=warehouse&id="+wh,
			`{"productId":"`+pid+`","variantSize":"50ml","newQty":`+strconv.Itoa(qty)+`,"reason":"uji hapus gudang"}`), "adjust")
	}
	transfer := func(t *testing.T, src, dst write.TransferLoc) {
		t.Helper()
		if _, err := repo.CreateTransfer(ctx, "", write.TransferCreate{
			Source: src, Dest: dst,
			Items: []write.TransferItemInput{{ProductID: pid, VariantSize: "50ml", Qty: 1}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Counted independently of the guard: every document table that names a warehouse.
	documents := func(t *testing.T, wh string) int {
		return one(t, `SELECT (SELECT count(*) FROM goods_receipts WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM warehouse_stock_adjustments WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM stock_counts WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM transfers WHERE source_warehouse_id=$1 OR dest_warehouse_id=$1)
		                 + (SELECT count(*) FROM ingredient_goods_receipts WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM ingredient_stock_adjustments WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM ingredient_stock_counts WHERE warehouse_id=$1)
		                 + (SELECT count(*) FROM ingredient_transfers WHERE source_warehouse_id=$1 OR dest_warehouse_id=$1)`, wh)
	}
	stockRows := func(t *testing.T, wh string) int {
		return one(t, `SELECT count(*)::int FROM warehouse_variant_stock WHERE warehouse_id=$1`, wh)
	}
	balance := func(t *testing.T, wh string) int {
		return one(t, `SELECT COALESCE(sum(abs(stock)),0)::int FROM warehouse_variant_stock WHERE warehouse_id=$1`, wh)
	}
	exists := func(t *testing.T, wh string) bool {
		return one(t, `SELECT count(*)::int FROM warehouses WHERE id=$1`, wh) == 1
	}
	whLoc := func(id string) write.TransferLoc { return write.TransferLoc{Kind: "warehouse", ID: id} }
	outletA := write.TransferLoc{Kind: "outlet", ID: slOutletA}

	cases := []struct {
		name    string
		id      string
		history func(t *testing.T, wh string) // ends with every stock row of the warehouse at zero
	}{
		{"receipt then adjust to zero", "00000000-0000-4000-8f67-0000000000e2", func(t *testing.T, wh string) {
			receipt(t, wh, 3)
			// D13 first: while stocked, the refusal is about the stock, not the history.
			w := send(http.MethodDelete, "/warehouses/"+wh, "")
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "gudang masih punya stok") ||
				!strings.Contains(w.Body.String(), "nonaktifkan gudang") {
				t.Fatalf("delete while stocked = %d %s, want the D13 stock 409", w.Code, w.Body.String())
			}
			adjust(t, wh, 0)
		}},
		{"adjust up and back only", "00000000-0000-4000-8f67-0000000000e3", func(t *testing.T, wh string) {
			adjust(t, wh, 4)
			adjust(t, wh, 0)
		}},
		{"draft transfer out of the warehouse", "00000000-0000-4000-8f67-0000000000e4", func(t *testing.T, wh string) {
			transfer(t, whLoc(wh), outletA)
		}},
		{"draft transfer into the warehouse", "00000000-0000-4000-8f67-0000000000e5", func(t *testing.T, wh string) {
			transfer(t, outletA, whLoc(wh))
		}},
		{"stock count", "00000000-0000-4000-8f67-0000000000e6", func(t *testing.T, wh string) {
			exec(t, `INSERT INTO stock_counts(name,status,warehouse_id) VALUES('SL opname','planned',$1)`, wh)
		}},
		{"ingredient receipt", "00000000-0000-4000-8f67-0000000000e7", func(t *testing.T, wh string) {
			exec(t, `WITH r AS (INSERT INTO ingredient_goods_receipts(warehouse_id,supplier) VALUES($1,'CV Uji') RETURNING id)
			         INSERT INTO ingredient_goods_receipt_items(receipt_id,ingredient_id,qty) SELECT id,$2,1 FROM r`, wh, ingID)
		}},
		{"ingredient adjustment", "00000000-0000-4000-8f67-0000000000e8", func(t *testing.T, wh string) {
			exec(t, `INSERT INTO ingredient_stock_adjustments(warehouse_id,ingredient_id,new_qty,reason) VALUES($1,$2,0,'uji')`, wh, ingID)
		}},
		{"ingredient stock count", "00000000-0000-4000-8f67-0000000000e9", func(t *testing.T, wh string) {
			exec(t, `INSERT INTO ingredient_stock_counts(name,status,warehouse_id) VALUES('SL opname bahan','planned',$1)`, wh)
		}},
		{"ingredient transfer", "00000000-0000-4000-8f67-0000000000ea", func(t *testing.T, wh string) {
			exec(t, `INSERT INTO ingredient_transfers(source_warehouse_id,dest_warehouse_id) VALUES($1,$2)`, other, wh)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'SL wh '||$2) ON CONFLICT DO NOTHING`, tc.id, tc.name)
			tc.history(t, tc.id)
			if b := balance(t, tc.id); b != 0 {
				t.Fatalf("fixture balance = %d, want zero everywhere", b)
			}
			docs, rows := documents(t, tc.id), stockRows(t, tc.id)
			if docs == 0 {
				t.Fatal("fixture wrote no document")
			}
			w := send(http.MethodDelete, "/warehouses/"+tc.id, "")
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "riwayat stok") || !strings.Contains(w.Body.String(), "nonaktifkan gudang") {
				t.Fatalf("delete of a zeroed warehouse with history = %d %s, want 409 naming the history and deactivate", w.Code, w.Body.String())
			}
			if !exists(t, tc.id) || documents(t, tc.id) != docs || stockRows(t, tc.id) != rows {
				t.Fatal("a refused delete must leave the warehouse, its documents and its stock rows untouched")
			}
			assertLedgerInvariant(t, ctx, pool)
		})
	}

	t.Run("zero stock row and no history still deletes", func(t *testing.T) {
		const wh = "00000000-0000-4000-8f67-0000000000eb"
		exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'SL wh clean') ON CONFLICT DO NOTHING`, wh)
		exec(t, `INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'50ml',0)`, wh, pid)
		wantOK(t, send(http.MethodDelete, "/warehouses/"+wh, ""), "delete without history")
		if exists(t, wh) || stockRows(t, wh) != 0 {
			t.Fatal("warehouse or its zero stock row survived the delete")
		}
	})
}
