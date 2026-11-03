package handlers

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// TestLockOrderPostgres (A42): sales with reversed carts, and a sale racing a
// refund on the same customer and stock rows, must never deadlock. The service
// is driven directly (no retry wrapper), so ANY lock-conflict error fails the
// test: the deterministic lock order itself is what is proven. Final stock is
// asserted exactly.
func TestLockOrderPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "LO", 26454)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const outlet = "00000000-0000-4000-8000-000000000001"
	const user = "00000000-0000-4000-8000-000000000002"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'Synthetic outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'synthetic@example.invalid','not-a-login-hash','Synthetic cashier','cashier',$2)`, user, outlet)
	svc := service.NewOrderService(pool)

	var seq atomic.Int64
	newProduct := func(withStockRow bool) string {
		n := seq.Add(1)
		id := fmt.Sprintf("00000000-0000-4000-9000-%012d", n)
		exec(`INSERT INTO products(id,name) VALUES($1,'p')`, id)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,0,$2)`, id, fmt.Sprintf("SKU-%d", n))
		if withStockRow {
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000000)`, outlet, id)
		}
		return id
	}
	sale := func(customer string, products ...string) (string, error) {
		n := seq.Add(1)
		items := make([]service.OrderItem, len(products))
		for i, p := range products {
			items[i] = service.OrderItem{ProductID: p, ProductName: "p", VariantSize: "110ml", Price: 100000, Quantity: 1, Subtotal: 100000}
		}
		id, _, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: fmt.Sprintf("lo-key-%d", n), OrderUUID: fmt.Sprintf("00000000-0000-4000-8002-%012d", n),
			OutletID: outlet, CashierID: user, CashierName: "c", CustomerID: customer,
			Items: items, PaymentMethod: "cash", AmountPaid: float64(100000 * len(products)),
		})
		return id, err
	}
	stockOf := func(p string) int {
		var s int
		if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, p).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	// race runs every fn at once behind a barrier and fails on any error.
	race := func(label string, fns ...func() error) {
		t.Helper()
		var ready, wg sync.WaitGroup
		start := make(chan struct{})
		errs := make(chan error, len(fns))
		for _, fn := range fns {
			ready.Add(1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				ready.Done()
				<-start
				if err := fn(); err != nil {
					errs <- err
				}
			}()
		}
		ready.Wait()
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("%s: %v", label, err)
		}
	}
	noID := func(f func() (string, error)) func() error {
		return func() error { _, err := f(); return err }
	}

	t.Run("sale_vs_sale_reversed_carts", func(t *testing.T) {
		a, b := newProduct(true), newProduct(true)
		const iters = 40
		for i := 0; i < iters; i++ {
			race("existing rows",
				noID(func() (string, error) { return sale("", a, b) }), noID(func() (string, error) { return sale("", b, a) }),
				noID(func() (string, error) { return sale("", a, b) }), noID(func() (string, error) { return sale("", b, a) }))
		}
		if got, want := stockOf(a), 1000000-4*iters; got != want {
			t.Fatalf("stock a=%d want %d", got, want)
		}
		if got, want := stockOf(b), 1000000-4*iters; got != want {
			t.Fatalf("stock b=%d want %d", got, want)
		}
	})

	t.Run("sale_vs_sale_new_stock_rows", func(t *testing.T) {
		// No outlet_variant_stock row yet: the lazy ensure-row INSERTs are themselves
		// lock acquisitions and must also run in the sorted order.
		for i := 0; i < 30; i++ {
			x, y := newProduct(false), newProduct(false)
			race("new rows",
				noID(func() (string, error) { return sale("", x, y) }), noID(func() (string, error) { return sale("", y, x) }))
			// A44 owner decision 2026-10-14 (never hide a shortfall): rows were created
			// lazily at 0 and the two online sales (qty 1 each) now record the true
			// negative -2/-2 instead of flooring at 0. Both rows exist (stockOf fails on
			// a missing row).
			if sx, sy := stockOf(x), stockOf(y); sx != -2 || sy != -2 {
				t.Fatalf("new rows: stock x=%d y=%d, want -2/-2", sx, sy)
			}
		}
	})

	t.Run("goods_receipt_vs_sale_reversed", func(t *testing.T) {
		a, b := newProduct(true), newProduct(true)
		wr := write.New(pool)
		receipt := func(first, second string) func() error {
			return func() error {
				return wr.CreateLocationGoodsReceipt(ctx, "outlet", outlet, user, write.GoodsReceipt{Items: []write.GoodsReceiptItem{
					{ProductID: first, VariantSize: "110ml", Qty: 5}, {ProductID: second, VariantSize: "110ml", Qty: 5}}})
			}
		}
		const iters = 30
		for i := 0; i < iters; i++ {
			race("receipt vs sale", receipt(a, b), receipt(b, a),
				noID(func() (string, error) { return sale("", b, a) }), noID(func() (string, error) { return sale("", a, b) }))
		}
		want := 1000000 + iters*(2*5-2)
		if sa, sb := stockOf(a), stockOf(b); sa != want || sb != want {
			t.Fatalf("stock a=%d b=%d want %d", sa, sb, want)
		}
	})

	t.Run("warehouse_goods_receipt_reversed_and_duplicate_lines", func(t *testing.T) {
		a, b := newProduct(true), newProduct(true)
		const wh = "00000000-0000-4000-b000-000000000001"
		exec(`INSERT INTO warehouses(id,name) VALUES($1,'LO warehouse')`, wh)
		wr := write.New(pool)
		receipt := func(lines ...string) func() error {
			return func() error {
				items := make([]write.GoodsReceiptItem, len(lines))
				for i, p := range lines {
					items[i] = write.GoodsReceiptItem{ProductID: p, VariantSize: "110ml", Qty: 3}
				}
				return wr.CreateLocationGoodsReceipt(ctx, "warehouse", wh, user, write.GoodsReceipt{Items: items})
			}
		}
		const iters = 20
		for i := 0; i < iters; i++ {
			// a,b,a (duplicate line sums to 6 for a) racing b,a
			race("warehouse receipts", receipt(a, b, a), receipt(b, a), receipt(a, b, a), receipt(b, a))
		}
		var sa, sb int
		if err := pool.QueryRow(ctx, `SELECT (SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2), (SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$3)`, wh, a, b).Scan(&sa, &sb); err != nil {
			t.Fatal(err)
		}
		// per iteration: a = 2 receipts x 6 + 2 x 3 = 18, b = 2 x 3 + 2 x 3 = 12
		if sa != iters*18 || sb != iters*12 {
			t.Fatalf("warehouse stock a=%d b=%d want %d/%d", sa, sb, iters*18, iters*12)
		}
	})

	newCustomer := func() string {
		id := fmt.Sprintf("00000000-0000-4000-a000-%012d", seq.Add(1))
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'Merge customer','merge-phone',100)`, id)
		return id
	}
	// keeperFirst creates the keeper before the dup so keeper id < dup id (merge locks
	// the pair in id order; both orientations must be exercised).
	mergePair := func(keeperFirst bool) (cand, dup, keeper string) {
		if keeperFirst {
			keeper = newCustomer()
			dup = newCustomer()
		} else {
			dup = newCustomer()
			keeper = newCustomer()
		}
		if err := pool.QueryRow(ctx, `INSERT INTO customer_dup_candidates(new_customer_id,existing_customer_id,phone) VALUES($1,$2,'merge-phone') RETURNING id`, dup, keeper).Scan(&cand); err != nil {
			t.Fatal(err)
		}
		return
	}

	t.Run("sale_vs_merge", func(t *testing.T) {
		exec(`UPDATE loyalty_settings SET enabled=true`)
		a, b := newProduct(true), newProduct(true)
		wr := write.New(pool)
		for i := 0; i < 20; i++ {
			cand, dup, keeper := mergePair(i%2 == 1) // alternate id orientation
			race("sale vs merge",
				func() error { return wr.MergeCustomers(ctx, cand, keeper, nil, user, "c") },
				noID(func() (string, error) { return sale(dup, a, b) }),
				noID(func() (string, error) { return sale(dup, b, a) }))
			var orders, onDup, keeperPts, dupPts, earned int
			var spent float64
			var mergedInto *string
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM orders WHERE customer_id=$1), (SELECT count(*) FROM orders WHERE customer_id=$2),
				(SELECT total_spent FROM customers WHERE id=$1), (SELECT points FROM customers WHERE id=$1), (SELECT points FROM customers WHERE id=$2),
				(SELECT merged_into::text FROM customers WHERE id=$2), (SELECT COALESCE(sum(points_earned),0) FROM orders WHERE customer_id=$1)`,
				keeper, dup).Scan(&orders, &onDup, &spent, &keeperPts, &dupPts, &mergedInto, &earned); err != nil {
				t.Fatal(err)
			}
			// Every sale ends on the live keeper: none left on the tombstone, the keeper's
			// aggregate carries both 200000 sales, the dup's 100 points moved over and the
			// two sales' earned points landed on the keeper; the dup is a tombstone.
			if orders != 2 || onDup != 0 || spent != 400000 {
				t.Fatalf("iteration %d: keeper orders=%d dup orders=%d keeper total_spent=%v", i, orders, onDup, spent)
			}
			if keeperPts != 200+earned || dupPts != 0 || mergedInto == nil || *mergedInto != keeper {
				t.Fatalf("iteration %d: keeper points=%d (want %d) dup points=%d merged_into=%v keeper=%s", i, keeperPts, 200+earned, dupPts, mergedInto, keeper)
			}
		}
	})

	t.Run("refund_retries_after_merge_moves_customer", func(t *testing.T) {
		exec(`UPDATE loyalty_settings SET enabled=true`)
		a := newProduct(true)
		_, dup, keeper := mergePair(true)
		order, err := sale(dup, a)
		var earned int
		if err == nil {
			err = pool.QueryRow(ctx, `SELECT points_earned FROM orders WHERE id=$1`, order).Scan(&earned)
		}
		if err != nil {
			t.Fatal(err)
		}
		// Hold the dup customer lock (as a merge does) and let the refund read the
		// order unlocked and queue on that lock.
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SELECT 1 FROM customers WHERE id=$1 FOR UPDATE`, dup); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			done <- svc.Refund(ctx, service.RefundInput{OutletID: outlet, OrderID: order, Reason: "merge race", UserID: user, UserName: "c"})
		}()
		deadline := time.Now().Add(15 * time.Second)
		for {
			var waiting int
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT 1 FROM customers%'`).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("refund never queued on the customer lock")
			}
			time.Sleep(10 * time.Millisecond)
		}
		// The "merge" moves the order to the keeper and commits.
		if _, err = tx.Exec(ctx, `UPDATE orders SET customer_id=$1 WHERE id=$2`, keeper, order); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err = <-done; !errors.Is(err, write.ErrBusy) {
			t.Fatalf("refund must abort as retryable busy with nothing applied, got %v", err)
		}
		var status string
		if err = pool.QueryRow(ctx, `SELECT status FROM orders WHERE id=$1`, order).Scan(&status); err != nil || status != "completed" {
			t.Fatalf("busy refund must apply nothing: status=%q err=%v", status, err)
		}
		// The retry runs against the keeper and succeeds.
		if err = write.RetryBusy(ctx, func() error {
			return svc.Refund(ctx, service.RefundInput{OutletID: outlet, OrderID: order, Reason: "merge race", UserID: user, UserName: "c"})
		}); err != nil {
			t.Fatalf("retry after the merge: %v", err)
		}
		var keeperPts int
		if err = pool.QueryRow(ctx, `SELECT status FROM orders WHERE id=$1`, order).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if err = pool.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1`, keeper).Scan(&keeperPts); err != nil {
			t.Fatal(err)
		}
		// Refunded, exact restock, and the clawback hit the KEEPER (its own 100 points,
		// floor 0), not the tombstone.
		if status != "refunded" || stockOf(a) != 1000000 {
			t.Fatalf("after retry: status=%q stock=%d (want refunded / 1000000)", status, stockOf(a))
		}
		if want := 100 - write.PointsClawback(100, earned); keeperPts != want {
			t.Fatalf("keeper points=%d want %d (earned %d)", keeperPts, want, earned)
		}
	})

	for _, loyalty := range []bool{false, true} {
		t.Run(fmt.Sprintf("sale_vs_refund_loyalty_%v", loyalty), func(t *testing.T) {
			exec(`UPDATE loyalty_settings SET enabled=$1`, loyalty)
			a, b := newProduct(true), newProduct(true)
			cust := fmt.Sprintf("00000000-0000-4000-a000-%012d", seq.Add(1))
			exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'LO customer',$2,100)`, cust, "lo-"+strings.ToLower(cust))
			const iters = 30
			for i := 0; i < iters; i++ {
				old, err := sale(cust, a, b)
				if err != nil {
					t.Fatal(err)
				}
				race("sale vs refund",
					func() error {
						return svc.Refund(ctx, service.RefundInput{OutletID: outlet, OrderID: old, Reason: "lock order test", UserID: user, UserName: "c"})
					},
					noID(func() (string, error) { return sale(cust, b, a) }),
					noID(func() (string, error) { return sale(cust, a, b) }))
			}
			// per iteration: the pre-sale (-1) refunded (+1) and two racing sales (-2)
			if got, want := stockOf(a), 1000000-2*iters; got != want {
				t.Fatalf("stock a=%d want %d", got, want)
			}
			if got, want := stockOf(b), 1000000-2*iters; got != want {
				t.Fatalf("stock b=%d want %d", got, want)
			}
		})
	}
}
