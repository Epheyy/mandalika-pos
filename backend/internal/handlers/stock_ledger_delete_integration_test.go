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

// slDeleteZeroed: a product whose every balance is zero but whose variant has stock
// history (a goods receipt, an adjustment or a transfer line, all of which keep a plain
// foreign key to products) cannot be hard-deleted. The delete answers 409 naming that
// reason and the supported alternative (deactivate) instead of the generic 400 the
// foreign-key violation produced, and it changes nothing. The D13 order holds: a stocked
// product is still refused for its stock first, and a product with no history still
// deletes.
func slDeleteZeroed(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
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
	exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'SL warehouse') ON CONFLICT DO NOTHING`, slWarehouse)

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
	router.Delete("/products/{id}", h.DeleteProduct)
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
	receipt := func(t *testing.T, kind, loc, pid string, qty int) {
		t.Helper()
		wantOK(t, send(http.MethodPost, "/inventory/goods-receipt?kind="+kind+"&id="+loc,
			`{"supplier":"CV Uji","items":[{"productId":"`+pid+`","variantSize":"50ml","qty":`+strconv.Itoa(qty)+`}]}`), "receipt")
	}
	adjust := func(t *testing.T, kind, loc, pid string, qty int) {
		t.Helper()
		wantOK(t, send(http.MethodPost, "/inventory/adjust?kind="+kind+"&id="+loc,
			`{"productId":"`+pid+`","variantSize":"50ml","newQty":`+strconv.Itoa(qty)+`,"reason":"uji hapus"}`), "adjust")
	}
	product := func(t *testing.T, id string) {
		t.Helper()
		exec(t, `INSERT INTO products(id,name) VALUES($1::uuid,'SL delete '||$2) ON CONFLICT DO NOTHING`, id, id)
		exec(t, `INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES($1::uuid,'50ml',100000,'SKU-'||$2,'BC-'||$2)
		      ON CONFLICT DO NOTHING`, id, id)
	}
	history := func(t *testing.T, pid string) int {
		return one(t, `SELECT (SELECT count(*) FROM goods_receipt_items WHERE product_id=$1)
		                 + (SELECT count(*) FROM warehouse_stock_adjustments WHERE product_id=$1)
		                 + (SELECT count(*) FROM transfer_items WHERE product_id=$1)
		                 + (SELECT count(*) FROM stock_movements WHERE product_id=$1)`, pid)
	}
	balance := func(t *testing.T, pid string) int {
		return one(t, `SELECT (SELECT COALESCE(sum(abs(stock)),0) FROM outlet_variant_stock WHERE product_id=$1)
		                 + (SELECT COALESCE(sum(abs(stock)),0) FROM warehouse_variant_stock WHERE product_id=$1)`, pid)
	}
	exists := func(t *testing.T, pid string) bool {
		return one(t, `SELECT count(*)::int FROM products WHERE id=$1`, pid) == 1
	}

	cases := []struct {
		name    string
		id      string
		history func(t *testing.T, pid string) // writes history through the real paths, ends at zero everywhere
	}{
		{"outlet receipt then adjust to zero", "00000000-0000-4000-8f67-0000000000f1", func(t *testing.T, pid string) {
			receipt(t, "outlet", slOutletA, pid, 3)
			// D13 first: while stocked, the refusal is about the stock, not the history.
			w := send(http.MethodDelete, "/products/"+pid, "")
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "produk masih punya stok") ||
				!strings.Contains(w.Body.String(), "nonaktifkan produk") {
				t.Fatalf("delete while stocked = %d %s, want the D13 stock 409", w.Code, w.Body.String())
			}
			adjust(t, "outlet", slOutletA, pid, 0)
		}},
		{"warehouse receipt then adjust to zero", "00000000-0000-4000-8f67-0000000000f2", func(t *testing.T, pid string) {
			receipt(t, "warehouse", slWarehouse, pid, 2)
			adjust(t, "warehouse", slWarehouse, pid, 0)
		}},
		{"adjust up and back only", "00000000-0000-4000-8f67-0000000000f3", func(t *testing.T, pid string) {
			adjust(t, "outlet", slOutletA, pid, 4)
			adjust(t, "outlet", slOutletA, pid, 0)
		}},
		{"draft transfer line only", "00000000-0000-4000-8f67-0000000000f4", func(t *testing.T, pid string) {
			if _, err := repo.CreateTransfer(ctx, "", write.TransferCreate{
				Source: write.TransferLoc{Kind: "warehouse", ID: slWarehouse},
				Dest:   write.TransferLoc{Kind: "outlet", ID: slOutletA},
				Items:  []write.TransferItemInput{{ProductID: pid, VariantSize: "50ml", Qty: 1}},
			}); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			product(t, tc.id)
			tc.history(t, tc.id)
			if b := balance(t, tc.id); b != 0 {
				t.Fatalf("fixture balance = %d, want zero everywhere", b)
			}
			hist := history(t, tc.id)
			rows := one(t, `SELECT (SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1)
			                     + (SELECT count(*) FROM warehouse_variant_stock WHERE product_id=$1)`, tc.id)
			if hist == 0 {
				t.Fatal("fixture wrote no history")
			}
			w := send(http.MethodDelete, "/products/"+tc.id, "")
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "riwayat stok") || !strings.Contains(w.Body.String(), "nonaktifkan produk") {
				t.Fatalf("delete of a zeroed product with history = %d %s, want 409 naming the history and deactivate", w.Code, w.Body.String())
			}
			if !exists(t, tc.id) || history(t, tc.id) != hist || one(t, `SELECT (SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1)
			                     + (SELECT count(*) FROM warehouse_variant_stock WHERE product_id=$1)`, tc.id) != rows {
				t.Fatal("a refused delete must leave the product and its history untouched")
			}
			assertLedgerInvariant(t, ctx, pool)
		})
	}

	t.Run("zero stock row and no history still deletes", func(t *testing.T) {
		const pid = "00000000-0000-4000-8f67-0000000000f5"
		product(t, pid)
		exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'50ml',0)`, slOutletA, pid)
		wantOK(t, send(http.MethodDelete, "/products/"+pid, ""), "delete without history")
		if exists(t, pid) || one(t, `SELECT count(*)::int FROM outlet_variant_stock WHERE product_id=$1`, pid) != 0 {
			t.Fatal("product or its zero stock row survived the delete")
		}
	})
}
