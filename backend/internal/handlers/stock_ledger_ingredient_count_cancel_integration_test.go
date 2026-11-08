package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/write"
)

// slIngredientCountCancel: an ingredient stock count that was created or started by mistake can
// be abandoned (planned | in_progress -> cancelled) without touching stock; a completed or
// already cancelled count cannot, and a cancelled count refuses Start/Save/Complete.
func slIngredientCountCancel(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	const (
		wh    = "00000000-0000-4000-8f67-0000000000d0"
		ingID = "00000000-0000-4000-8f67-0000000000d1"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'SL count cancel wh') ON CONFLICT DO NOTHING`, wh)
	exec(`INSERT INTO ingredients(id,name,unit) VALUES($1,'SL count cancel ingredient','ml') ON CONFLICT DO NOTHING`, ingID)
	exec(`INSERT INTO ingredient_warehouse_stock(warehouse_id,ingredient_id,qty) VALUES($1,$2,10)
	      ON CONFLICT (warehouse_id,ingredient_id) DO UPDATE SET qty=10`, wh, ingID)

	repo := write.New(pool)
	h := &Handlers{Write: repo}
	router := chi.NewRouter()
	router.Post("/ingredient-stock-counts/{id}/cancel", h.CancelIngredientStockCount)
	cancelHTTP := func(id string) int {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/ingredient-stock-counts/"+id+"/cancel", nil))
		return w.Code
	}

	str := func(sql string, args ...any) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	status := func(id string) string {
		return str(`SELECT status FROM ingredient_stock_counts WHERE id=$1`, id)
	}
	stockQty := func() string {
		return str(`SELECT qty::text FROM ingredient_warehouse_stock WHERE warehouse_id=$1 AND ingredient_id=$2`, wh, ingID)
	}
	items := func(id string) int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ingredient_stock_count_items WHERE stock_count_id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	create := func(name string) string {
		t.Helper()
		id, err := repo.CreateIngredientStockCount(ctx, "", write.IngredientStockCount{Name: name, LocKind: "warehouse", LocID: wh})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	mustErr := func(what string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: want an error", what)
		}
	}

	t.Run("planned", func(t *testing.T) {
		id := create("planned cancel")
		if err := repo.CancelIngredientStockCount(ctx, id); err != nil {
			t.Fatal(err)
		}
		if got := status(id); got != "cancelled" {
			t.Fatalf("status = %s", got)
		}
		if got := stockQty(); got != "10.000" {
			t.Fatalf("stock changed by cancel: %s", got)
		}
	})

	t.Run("in-progress keeps items and stock", func(t *testing.T) {
		id := create("started cancel")
		if err := repo.StartIngredientStockCount(ctx, id); err != nil {
			t.Fatal(err)
		}
		n := items(id)
		if n == 0 {
			t.Fatal("start snapshotted no items")
		}
		itemID := str(`SELECT id::text FROM ingredient_stock_count_items WHERE stock_count_id=$1 AND ingredient_id=$2`, id, ingID)
		if err := repo.SaveIngredientStockCount(ctx, id, []write.IngredientStockCountSaveItem{{ItemID: itemID, Counted: 3}}); err != nil {
			t.Fatal(err)
		}
		if err := repo.CancelIngredientStockCount(ctx, id); err != nil {
			t.Fatal(err)
		}
		if got := status(id); got != "cancelled" {
			t.Fatalf("status = %s", got)
		}
		if got := items(id); got != n {
			t.Fatalf("items = %d, want %d (history kept)", got, n)
		}
		if got := stockQty(); got != "10.000" {
			t.Fatalf("cancel applied counted qty to stock: %s", got)
		}
		// A cancelled count refuses every other transition.
		mustErr("start cancelled", repo.StartIngredientStockCount(ctx, id))
		mustErr("save cancelled", repo.SaveIngredientStockCount(ctx, id, []write.IngredientStockCountSaveItem{{ItemID: itemID, Counted: 4}}))
		mustErr("complete cancelled", repo.CompleteIngredientStockCount(ctx, id))
		mustErr("cancel cancelled", repo.CancelIngredientStockCount(ctx, id))
		if got := stockQty(); got != "10.000" {
			t.Fatalf("stock after refused transitions: %s", got)
		}
	})

	t.Run("completed cannot be cancelled", func(t *testing.T) {
		id := create("completed cancel")
		if err := repo.StartIngredientStockCount(ctx, id); err != nil {
			t.Fatal(err)
		}
		if err := repo.CompleteIngredientStockCount(ctx, id); err != nil {
			t.Fatal(err)
		}
		mustErr("cancel completed", repo.CancelIngredientStockCount(ctx, id))
		if got := status(id); got != "completed" {
			t.Fatalf("status = %s", got)
		}
	})

	t.Run("http status mapping", func(t *testing.T) {
		if got := cancelHTTP("00000000-0000-4000-8f67-0000000000d9"); got != http.StatusNotFound {
			t.Fatalf("unknown id = %d, want 404", got)
		}
		id := create("http cancel")
		if got := cancelHTTP(id); got != http.StatusOK {
			t.Fatalf("cancel = %d, want 200", got)
		}
		if got := cancelHTTP(id); got != http.StatusBadRequest {
			t.Fatalf("cancel again = %d, want 400 (same as start/complete guard errors)", got)
		}
	})
}

// slStatusChecks: migration 0084 closes the status sets of transfers and customer_dup_candidates.
func slStatusChecks(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	slSetup(t, ctx, pool)
	for _, st := range []string{"draft", "in_transit", "completed", "cancelled"} {
		if _, err := pool.Exec(ctx, `INSERT INTO transfers(status,source_outlet_id,dest_outlet_id) VALUES($1,$2,$3)`, st, slOutletA, slOutletB); err != nil {
			t.Fatalf("transfers status %q rejected: %v", st, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO transfers(status,source_outlet_id,dest_outlet_id) VALUES('received',$1,$2)`, slOutletA, slOutletB); err == nil {
		t.Fatal("transfers accepted status 'received'")
	}
	if _, err := pool.Exec(ctx, `UPDATE transfers SET status='bogus' WHERE source_outlet_id=$1`, slOutletA); err == nil {
		t.Fatal("transfers UPDATE accepted status 'bogus'")
	}

	// One pair per row: the pair is unique.
	pair := func(n int) (string, string) {
		var a, b string
		if err := pool.QueryRow(ctx, `INSERT INTO customers(name,phone) VALUES('SL chk new','0811-sl-chk-n'||$1::text) RETURNING id::text`, n).Scan(&a); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO customers(name,phone) VALUES('SL chk old','0811-sl-chk-o'||$1::text) RETURNING id::text`, n).Scan(&b); err != nil {
			t.Fatal(err)
		}
		return a, b
	}
	for i, st := range []string{"pending", "merged", "dismissed"} {
		a, b := pair(i)
		if _, err := pool.Exec(ctx, `INSERT INTO customer_dup_candidates(new_customer_id,existing_customer_id,phone,status) VALUES($1,$2,'0811-sl-chk',$3)`, a, b, st); err != nil {
			t.Fatalf("dup candidate status %q rejected: %v", st, err)
		}
	}
	a, b := pair(9)
	if _, err := pool.Exec(ctx, `INSERT INTO customer_dup_candidates(new_customer_id,existing_customer_id,phone,status) VALUES($1,$2,'0811-sl-chk','resolved')`, a, b); err == nil {
		t.Fatal("customer_dup_candidates accepted status 'resolved'")
	}
}
