package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

const (
	stUser   = "00000000-0000-4000-8f58-000000000101"
	stShift  = "00000000-0000-4000-8f58-000000000102"
	stWhA    = "00000000-0000-4000-8f58-000000000201"
	stWhB    = "00000000-0000-4000-8f58-000000000202"
	stSize   = "110ml"
	stSecret = "ST-INTEGRATION-SYNTHETIC-KEY"
)

// initWriters builds the real HTTP router (sale, refund, sync batch/version/pull) and
// the repositories the writer cases drive.
func (f *stFixture) initWriters(t *testing.T) {
	t.Helper()
	f.exec(t, `INSERT INTO warehouses(id,name) VALUES($1,'ST warehouse A'),($2,'ST warehouse B')`, stWhA, stWhB)
	f.exec(t, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'st@example.invalid','x','ST cashier','cashier',$2)`, stUser, stOutletA)
	f.exec(t, `INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'ST cashier','open',now(),0)`, stShift, stOutletA, stUser)
	rd, wr, svc := read.New(f.pool), write.New(f.pool), service.NewOrderService(f.pool)
	f.repo, f.svc = wr, svc
	h := New(rd, nil, auth.NewStore(f.pool), wr, svc, syncpkg.New(f.pool, rd, svc, wr), nil)
	f.h = h
	secret := []byte(stSecret)
	tk, err := auth.IssueAccess(secret, time.Hour, stUser, "cashier", stOutletA, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	f.token = tk
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("create_order")).Post("/orders", h.CreateOrder)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/sync/version", h.SyncVersion)
	router.With(authWrap).Get("/sync/pull", h.SyncPull)
	f.router = router
	if _, err = h.Sync.Version(f.ctx, stOutletA); err != nil {
		t.Fatal(err)
	}
}

func (f *stFixture) do(t *testing.T, method, path string, body any, key string) (int, string) {
	t.Helper()
	rdr := strings.NewReader("")
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = strings.NewReader(string(raw))
	}
	r := httptest.NewRequest(method, path, rdr)
	r.Header.Set("Authorization", "Bearer "+f.token)
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func (f *stFixture) str(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var s string
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func (f *stFixture) stock(t *testing.T, outlet, pid string) int {
	t.Helper()
	var n int
	err := f.pool.QueryRow(f.ctx, `SELECT COALESCE((SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3),0)`, outlet, pid, stSize).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

var stN int

// product creates a sellable product with one variant and, when stock >= 0, an outlet A stock row.
func (f *stFixture) product(t *testing.T, stock int) string {
	t.Helper()
	stN++
	pid := fmt.Sprintf("00000000-0000-4000-8f58-1%011d", stN)
	f.exec(t, `INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("ST product %d", stN))
	f.exec(t, `INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,0,$3)`, pid, stSize, fmt.Sprintf("ST%d", stN))
	if stock >= 0 {
		f.exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, stOutletA, pid, stSize, stock)
	}
	return pid
}

func (f *stFixture) payload(pid string, qty int, size string) map[string]any {
	stN++
	total := 100000 * qty
	return map[string]any{
		"orderUuid": fmt.Sprintf("00000000-0000-4000-8f58-2%011d", stN), "paymentMethod": "cash",
		"amountPaid": total, "shiftId": stShift,
		"items": []map[string]any{{"productId": pid, "productName": "ST product", "variantSize": size, "price": 100000, "quantity": qty, "subtotal": total}},
	}
}

// directSale posts through POST /orders and returns the order id.
func (f *stFixture) directSale(t *testing.T, key string, p map[string]any) string {
	t.Helper()
	code, body := f.do(t, "POST", "/orders", p, key)
	if code != 200 && code != 201 {
		t.Fatalf("direct sale %s: %d %s", key, code, body)
	}
	return f.str(t, `SELECT id::text FROM orders WHERE idempotency_key=$1`, key)
}

type stItem struct {
	Status   string `json:"status"`
	OrderID  string `json:"orderId"`
	Error    string `json:"error"`
	StockSeq *int64 `json:"stockSeq"`
}

type stBatch struct {
	Results  []stItem `json:"results"`
	Version  int64    `json:"version"`
	StockSeq *int64   `json:"stockSeq"`
}

// batchFull flushes one outbox item through /sync/batch and returns the whole result.
func (f *stFixture) batchFull(t *testing.T, typ, key string, payload any) stBatch {
	t.Helper()
	code, body := f.do(t, "POST", "/sync/batch", map[string]any{"items": []any{map[string]any{"type": typ, "idempotencyKey": key, "payload": payload}}}, "")
	var out struct {
		Data stBatch `json:"data"`
	}
	if code != 200 || json.Unmarshal([]byte(body), &out) != nil || len(out.Data.Results) != 1 {
		t.Fatalf("batch %s: %d %s", key, code, body)
	}
	return out.Data
}

func (f *stFixture) batch(t *testing.T, typ, key string, payload any) stItem {
	t.Helper()
	return f.batchFull(t, typ, key, payload).Results[0]
}

// wantDelta runs fn and requires outlet A's and B's counters to move by EXACTLY
// (a, b): "exactly" matters, a double bump must fail, not pass as ">= 1".
func (f *stFixture) wantDelta(t *testing.T, what string, a, b int64, fn func()) {
	t.Helper()
	a0, b0 := f.seq(t, stOutletA), f.seq(t, stOutletB)
	fn()
	if da, db := f.seq(t, stOutletA)-a0, f.seq(t, stOutletB)-b0; da != a || db != b {
		t.Fatalf("%s: outlet A delta %d (want %d), outlet B delta %d (want %d)", what, da, a, db, b)
	}
}

func (f *stFixture) must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *stFixture) setStock(t *testing.T, outlet, pid string, n int) {
	t.Helper()
	f.exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)
		ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=EXCLUDED.stock`, outlet, pid, stSize, n)
}

func (f *stFixture) setWhStock(t *testing.T, wh, pid string, n int) {
	t.Helper()
	f.exec(t, `INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)
		ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock=EXCLUDED.stock`, wh, pid, stSize, n)
}

func (f *stFixture) draft(t *testing.T, src, dst write.TransferLoc, pid string, qty int) string {
	t.Helper()
	id, err := f.repo.CreateTransfer(f.ctx, "", write.TransferCreate{Source: src, Dest: dst,
		Items: []write.TransferItemInput{{ProductID: pid, VariantSize: stSize, Qty: qty}}})
	f.must(t, err)
	return id
}

func stOutlet(id string) write.TransferLoc { return write.TransferLoc{Kind: "outlet", ID: id} }
func stWh(id string) write.TransferLoc     { return write.TransferLoc{Kind: "warehouse", ID: id} }

func (f *stFixture) runWriterCases(t *testing.T) {
	t.Run("W1 sale: direct, sync, oversell, unresolved variant each bump exactly once", func(t *testing.T) {
		pid := f.product(t, 10)
		f.wantDelta(t, "direct sale", 1, 0, func() { f.directSale(t, "st-direct-1", f.payload(pid, 1, stSize)) })
		f.wantDelta(t, "sync sale", 1, 0, func() {
			if it := f.batch(t, "order", "st-sync-1", f.payload(pid, 1, stSize)); it.Status != "ok" {
				t.Fatalf("status %s", it.Status)
			}
		})
		oversold := f.product(t, 0)
		f.wantDelta(t, "oversell direct", 1, 0, func() { f.directSale(t, "st-over-1", f.payload(oversold, 3, stSize)) })
		if got := f.stock(t, stOutletA, oversold); got != -3 {
			t.Fatalf("oversold stock %d", got)
		}
		f.wantDelta(t, "oversell sync", 1, 0, func() { f.batch(t, "order", "st-over-2", f.payload(oversold, 2, stSize)) })
		// A line with no variant moves no stock but the sale still counts once, so the
		// client's "one own sale = one bump" arithmetic holds.
		f.wantDelta(t, "unresolved variant", 1, 0, func() { f.directSale(t, "st-unres-1", f.payload(pid, 1, "999ml")) })
		// several lines of one SKU in one sale: still one bump per transaction
		multi := f.payload(pid, 1, stSize)
		lines := multi["items"].([]map[string]any)
		multi["items"] = append(lines, lines[0])
		multi["amountPaid"] = 200000
		f.wantDelta(t, "two-line sale", 1, 0, func() { f.directSale(t, "st-multi-1", multi) })
	})

	t.Run("W2 a replayed key moves neither stock nor the counter", func(t *testing.T) {
		pid := f.product(t, 10)
		p := f.payload(pid, 2, stSize)
		f.directSale(t, "st-replay-d", p)
		after := f.stock(t, stOutletA, pid)
		f.wantDelta(t, "direct replay", 0, 0, func() { f.directSale(t, "st-replay-d", p) })
		sp := f.payload(pid, 1, stSize)
		f.batch(t, "order", "st-replay-s", sp)
		f.wantDelta(t, "sync replay", 0, 0, func() {
			if it := f.batch(t, "order", "st-replay-s", sp); it.Status != "duplicate" {
				t.Fatalf("replay status %s", it.Status)
			}
		})
		if got := f.stock(t, stOutletA, pid); got != after-1 {
			t.Fatalf("stock %d want %d (replays must not move stock)", got, after-1)
		}
	})

	t.Run("W3 concurrent distinct sales bump exactly once each", func(t *testing.T) {
		pid := f.product(t, 100)
		const n = 8
		a0 := f.seq(t, stOutletA)
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			i := i
			p := f.payload(pid, 1, stSize)
			wg.Add(1)
			go func() {
				defer wg.Done()
				f.do(t, "POST", "/orders", p, fmt.Sprintf("st-conc-%d", i))
			}()
		}
		wg.Wait()
		if d := f.seq(t, stOutletA) - a0; d != n || f.stock(t, stOutletA, pid) != 100-n {
			t.Fatalf("delta %d stock %d, want %d / %d", d, f.stock(t, stOutletA, pid), n, 100-n)
		}
	})

	t.Run("W4 refund bumps exactly once (direct, oversold, sync) and a replay or repeat none", func(t *testing.T) {
		pid := f.product(t, 10)
		id := f.directSale(t, "st-ref-sale-1", f.payload(pid, 2, stSize))
		f.wantDelta(t, "direct refund", 1, 0, func() {
			if code, body := f.do(t, "POST", "/orders/"+id+"/refund", map[string]any{"reason": "salah input"}, ""); code != 200 && code != 201 {
				t.Fatalf("refund %d %s", code, body)
			}
		})
		f.wantDelta(t, "second refund of the same order is refused", 0, 0, func() {
			if code, _ := f.do(t, "POST", "/orders/"+id+"/refund", map[string]any{"reason": "again"}, ""); code == 200 || code == 201 {
				t.Fatalf("second refund accepted: %d", code)
			}
		})
		over := f.product(t, 0)
		oid := f.directSale(t, "st-ref-sale-2", f.payload(over, 2, stSize))
		f.wantDelta(t, "oversold refund", 1, 0, func() { f.do(t, "POST", "/orders/"+oid+"/refund", map[string]any{"reason": "oversold"}, "") })
		if got := f.stock(t, stOutletA, over); got != 0 {
			t.Fatalf("stock %d want 0", got)
		}
		sid := f.directSale(t, "st-ref-sale-3", f.payload(pid, 1, stSize))
		f.wantDelta(t, "sync refund", 1, 0, func() {
			if it := f.batch(t, "refund", "st-ref-sync-1", map[string]any{"orderId": sid, "reason": "sync"}); it.Status != "ok" {
				t.Fatalf("sync refund %+v", it)
			}
		})
		f.wantDelta(t, "sync refund replay", 0, 0, func() { f.batch(t, "refund", "st-ref-sync-1", map[string]any{"orderId": sid, "reason": "sync"}) })
		// a refund whose lines were all skipped by the sale (unresolved variant) still
		// counts once: the transaction committed a refund
		uid := f.directSale(t, "st-ref-sale-4", f.payload(pid, 1, "999ml"))
		f.wantDelta(t, "refund of a sale that moved no stock", 1, 0, func() { f.do(t, "POST", "/orders/"+uid+"/refund", map[string]any{"reason": "skipped"}, "") })
	})

	t.Run("W5 transfers: send, receive, cancel bump the right outlet once", func(t *testing.T) {
		pid := f.product(t, -1)
		f.setStock(t, stOutletA, pid, 20)
		// outlet A -> outlet B
		id := f.draft(t, stOutlet(stOutletA), stOutlet(stOutletB), pid, 5)
		f.wantDelta(t, "send from outlet", 1, 0, func() { f.must(t, f.repo.SendTransfer(f.ctx, id)) })
		recv := func() error {
			return f.repo.ReceiveTransfer(f.ctx, id, write.TransferReceive{}, write.ReceiveMeta{ReceivedVia: "pos", IdempotencyKey: "st-recv-1"})
		}
		f.wantDelta(t, "receive at outlet", 0, 1, func() { f.must(t, recv()) })
		f.wantDelta(t, "receive replay by the same key", 0, 0, func() { f.must(t, recv()) })
		// cancel an in-transit transfer restores the source and bumps it once
		id2 := f.draft(t, stOutlet(stOutletA), stOutlet(stOutletB), pid, 3)
		f.must(t, f.repo.SendTransfer(f.ctx, id2))
		f.wantDelta(t, "cancel in transit", 1, 0, func() { f.must(t, f.repo.CancelTransfer(f.ctx, id2)) })
		// cancel a draft moves no stock
		id3 := f.draft(t, stOutlet(stOutletA), stOutlet(stOutletB), pid, 3)
		f.wantDelta(t, "cancel draft", 0, 0, func() { f.must(t, f.repo.CancelTransfer(f.ctx, id3)) })
		// warehouse legs: only the outlet leg bumps
		f.setWhStock(t, stWhA, pid, 20)
		w2o := f.draft(t, stWh(stWhA), stOutlet(stOutletB), pid, 4)
		f.wantDelta(t, "send from warehouse", 0, 0, func() { f.must(t, f.repo.SendTransfer(f.ctx, w2o)) })
		f.wantDelta(t, "receive at outlet from warehouse", 0, 1, func() {
			f.must(t, f.repo.ReceiveTransfer(f.ctx, w2o, write.TransferReceive{}, write.ReceiveMeta{ReceivedVia: "backoffice"}))
		})
		o2w := f.draft(t, stOutlet(stOutletA), stWh(stWhB), pid, 2)
		f.wantDelta(t, "send outlet to warehouse", 1, 0, func() { f.must(t, f.repo.SendTransfer(f.ctx, o2w)) })
		f.wantDelta(t, "receive at warehouse", 0, 0, func() {
			f.must(t, f.repo.ReceiveTransfer(f.ctx, o2w, write.TransferReceive{}, write.ReceiveMeta{ReceivedVia: "backoffice"}))
		})
		w2w := f.draft(t, stWh(stWhA), stWh(stWhB), pid, 1)
		f.wantDelta(t, "warehouse to warehouse", 0, 0, func() {
			f.must(t, f.repo.SendTransfer(f.ctx, w2w))
			f.must(t, f.repo.ReceiveTransfer(f.ctx, w2w, write.TransferReceive{}, write.ReceiveMeta{ReceivedVia: "backoffice"}))
		})
		// a refused send (not enough stock) rolls back and consumes nothing
		big := f.draft(t, stOutlet(stOutletA), stOutlet(stOutletB), pid, 9999)
		f.wantDelta(t, "refused send", 0, 0, func() {
			if err := f.repo.SendTransfer(f.ctx, big); err == nil {
				t.Fatal("oversend accepted")
			}
		})
	})

	t.Run("W6 goods receipt and adjust bump the outlet leg only; par does not", func(t *testing.T) {
		pid := f.product(t, 5)
		gr := write.GoodsReceipt{Items: []write.GoodsReceiptItem{{ProductID: pid, VariantSize: stSize, Qty: 4}, {ProductID: pid, VariantSize: stSize, Qty: 1}}}
		f.wantDelta(t, "outlet goods receipt", 1, 0, func() { f.must(t, f.repo.CreateLocationGoodsReceipt(f.ctx, "outlet", stOutletA, "", gr)) })
		f.wantDelta(t, "outlet adjust", 0, 1, func() {
			f.must(t, f.repo.AdjustLocationStock(f.ctx, "outlet", stOutletB, "", write.WarehouseAdjust{ProductID: pid, VariantSize: stSize, NewQty: 7, Reason: "koreksi"}))
		})
		f.wantDelta(t, "warehouse goods receipt", 0, 0, func() { f.must(t, f.repo.CreateLocationGoodsReceipt(f.ctx, "warehouse", stWhA, "", gr)) })
		f.wantDelta(t, "warehouse adjust", 0, 0, func() {
			f.must(t, f.repo.AdjustLocationStock(f.ctx, "warehouse", stWhA, "", write.WarehouseAdjust{ProductID: pid, VariantSize: stSize, NewQty: 3, Reason: "koreksi"}))
		})
		par := 3
		f.wantDelta(t, "par level", 0, 0, func() { f.must(t, f.repo.SetOutletPar(f.ctx, stOutletA, pid, stSize, &par)) })
		if got := f.stock(t, stOutletA, pid); got != 10 {
			t.Fatalf("stock %d want 10 (par must not touch stock)", got)
		}
	})

	t.Run("W7 stock count: outlet complete bumps its own outlet once, replay and warehouse none", func(t *testing.T) {
		pid := f.product(t, 10)
		f.setStock(t, stOutletB, pid, 10)
		items := []write.StockCountItem{{ProductID: pid, ProductName: "ST product", VariantSize: stSize}}
		id, err := f.repo.CreateStockCount(f.ctx, stOutletA, "", write.StockCountCreate{Name: "ST count", Items: items})
		f.must(t, err)
		f.must(t, f.repo.UpdateStockCount(f.ctx, id, stOutletA, write.StockCountUpdate{Status: "in_progress"}))
		actual := 7
		counted := []write.StockCountItem{{ProductID: pid, ProductName: "ST product", VariantSize: stSize, ActualQty: &actual}}
		f.wantDelta(t, "outlet stock count complete", 1, 0, func() { f.must(t, f.repo.CompleteStockCount(f.ctx, id, stOutletA, counted)) })
		f.wantDelta(t, "stock count replay", 0, 0, func() { f.must(t, f.repo.CompleteStockCount(f.ctx, id, stOutletA, counted)) })
		if got := f.stock(t, stOutletA, pid); got != 7 || f.stock(t, stOutletB, pid) != 10 {
			t.Fatalf("A=%d B=%d", got, f.stock(t, stOutletB, pid))
		}
		f.setWhStock(t, stWhA, pid, 10)
		wid, err := f.repo.CreateStockCount(f.ctx, "", "", write.StockCountCreate{Name: "ST wh count", WarehouseID: stWhA, Items: items})
		f.must(t, err)
		f.must(t, f.repo.UpdateStockCount(f.ctx, wid, "", write.StockCountUpdate{Status: "in_progress"}))
		f.wantDelta(t, "warehouse stock count", 0, 0, func() { f.must(t, f.repo.CompleteStockCount(f.ctx, wid, "", counted)) })
	})

	t.Run("W8 product create refuses opening stock (D12) and writes no stock row; catalog edits do not bump", func(t *testing.T) {
		mk := func(name string, stock int) write.Product {
			return write.Product{Name: name, Sellable: true, IsActive: true,
				Variants: []write.Variant{{Size: stSize, Price: 100000, Stock: stock, SKU: "SKU-" + name}}}
		}
		f.wantDelta(t, "create with stock is refused", 0, 0, func() {
			if _, err := f.repo.CreateProduct(f.ctx, stOutletA, mk("seeded", 5)); err == nil {
				t.Fatal("create with stock 5 succeeded, want the D12 refusal")
			}
		})
		if n := f.str(t, `SELECT count(*)::text FROM products WHERE name='seeded'`); n != "0" {
			t.Fatalf("refused create left %s product rows", n)
		}
		if n := f.str(t, `SELECT count(*)::text FROM product_variants WHERE sku='SKU-seeded'`); n != "0" {
			t.Fatalf("refused create left %s variant rows", n)
		}
		var pid string
		f.wantDelta(t, "create with zero stock writes no stock row", 0, 0, func() {
			var err error
			pid, err = f.repo.CreateProduct(f.ctx, stOutletA, mk("unseeded", 0))
			f.must(t, err)
		})
		if n := f.str(t, `SELECT count(*)::text FROM outlet_variant_stock WHERE product_id=$1`, pid); n != "0" {
			t.Fatalf("zero create wrote %s stock rows", n)
		}
		// the rename/delete guards need a stocked variant: set it up as a fixture
		f.setStock(t, stOutletA, pid, 5)
		vid := f.str(t, `SELECT id::text FROM product_variants WHERE product_id=$1`, pid)
		renamed := mk("unseeded", 0)
		renamed.Variants[0].ID, renamed.Variants[0].Size = vid, "220ml"
		// D13: a stocked variant can be neither renamed nor deleted; the refusal changes nothing.
		f.wantDelta(t, "variant rename refused while stocked", 0, 0, func() {
			if err := f.repo.UpdateProduct(f.ctx, pid, renamed); !errors.Is(err, write.ErrVariantHasStock) {
				t.Fatalf("rename of a stocked variant: %v, want ErrVariantHasStock", err)
			}
		})
		f.wantDelta(t, "product delete refused while stocked", 0, 0, func() {
			if err := f.repo.DeleteProduct(f.ctx, pid); !errors.Is(err, write.ErrVariantHasStock) {
				t.Fatalf("delete of a stocked product: %v, want ErrVariantHasStock", err)
			}
		})
		f.setStock(t, stOutletA, pid, 0)
		f.wantDelta(t, "variant rename", 0, 0, func() { f.must(t, f.repo.UpdateProduct(f.ctx, pid, renamed)) })
		f.wantDelta(t, "availability and price config", 0, 0, func() {
			f.must(t, f.repo.SetProductOutletConfig(f.ctx, pid, []api.OutletConfigItemInput{
				{OutletId: uuid.MustParse(stOutletA), VariantSize: "220ml", Available: false}}))
		})
		f.wantDelta(t, "product delete", 0, 0, func() { f.must(t, f.repo.DeleteProduct(f.ctx, pid)) })
	})
}
