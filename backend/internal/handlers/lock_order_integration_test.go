package handlers

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
)

// TestLockOrderPostgres (A42): sales with reversed carts, and a sale racing a
// refund on the same customer and stock rows, must never deadlock. The service
// is driven directly (no retry wrapper), so ANY lock-conflict error fails the
// test: the deterministic lock order itself is what is proven. Final stock is
// asserted exactly.
func TestLockOrderPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "LO", 56454)
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
