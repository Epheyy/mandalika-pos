package handlers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/write"
)

// A13: concurrent transfer actions must apply a transition once and never
// double-move stock. Races are made deterministic (not timing based): a third
// session holds an EXCLUSIVE table lock on the stock table, the competing
// operations are started one at a time and each is awaited until it is either
// blocked on a lock (pg_stat_activity) or finished, then the lock is released.
// Opt-in fresh synthetic cluster only; same target guards as the other gates.
func TestTransferConcurrencyPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_TR_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated transfer-concurrency PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56445 || cfg.ConnConfig.Database != "mandalika_tr_synthetic" || cfg.ConnConfig.User != "tr_test" {
		t.Fatal("refusing non-fixture target")
	}
	cfg.MaxConns = 8
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_TR_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	f := &trFixture{ctx: ctx, pool: pool, repo: write.New(pool)}
	f.exec(`INSERT INTO outlets(id,name) VALUES($1,'TR outlet src'),($2,'TR outlet dst')`, trOutletSrc, trOutletDst)
	f.exec(`INSERT INTO warehouses(id,name) VALUES($1,'TR warehouse src'),($2,'TR warehouse dst')`, trWarehouseSrc, trWarehouseDst)

	for _, kind := range []string{"outlet", "warehouse"} {
		kind := kind
		t.Run("send-send-same-transfer/"+kind, func(t *testing.T) {
			src, dst := f.sourceDest(kind)
			p := f.product()
			f.setStock(src, p, 10)
			id := f.draft(src, dst, p, 4)
			errs := f.race(t, stockTable(src), f.send(id), f.send(id))
			wantOneSuccess(t, errs)
			if got := f.stock(src, p); got != 6 {
				t.Errorf("source stock %d, want 6 (decremented once)", got)
			}
			f.wantDocs(t, "surat_jalan_no", 1, id)
			f.wantStatus(t, id, "in_transit")
		})
	}
	t.Run("receive-receive-same-transfer", func(t *testing.T) {
		src, dst := loc{"warehouse", trWarehouseSrc}, loc{"outlet", trOutletDst}
		p := f.product()
		f.setStock(src, p, 10)
		id := f.draft(src, dst, p, 4)
		f.must(t, f.repo.SendTransfer(f.ctx, id))
		errs := f.race(t, stockTable(dst), f.receive(id), f.receive(id))
		wantOneSuccess(t, errs)
		if got := f.stock(dst, p); got != 4 {
			t.Errorf("dest stock %d, want 4 (credited once)", got)
		}
		f.wantDocs(t, "tanda_terima_no", 1, id)
		f.wantStatus(t, id, "completed")
	})
	t.Run("send-cancel-same-transfer", func(t *testing.T) {
		src, dst := loc{"outlet", trOutletSrc}, loc{"warehouse", trWarehouseDst}
		p := f.product()
		f.setStock(src, p, 10)
		id := f.draft(src, dst, p, 4)
		errs := f.race(t, stockTable(src), f.send(id), f.cancel(id))
		// Cancel is legal from draft AND in_transit, so send->cancel (both succeed,
		// stock restored) and cancel->send (send rejected) are both valid serial
		// orders. The invalid outcome is a successful cancel that a late send then
		// overwrites with in_transit while the source stock stays deducted.
		if errs[1] != nil {
			t.Errorf("cancel must succeed in either order: %v", errs[1])
		}
		f.wantStatus(t, id, "cancelled")
		if got := f.stock(src, p); got != 10 {
			t.Errorf("source stock %d, want 10 (cancelled transfer holds no stock)", got)
		}
		f.wantConserved(t, 10, p, src, dst, id)
	})
	t.Run("receive-cancel-same-transfer", func(t *testing.T) {
		src, dst := loc{"warehouse", trWarehouseSrc}, loc{"outlet", trOutletDst}
		p := f.product()
		f.setStock(src, p, 10)
		id := f.draft(src, dst, p, 4)
		f.must(t, f.repo.SendTransfer(f.ctx, id))
		errs := f.race(t, stockTable(dst), f.receive(id), f.cancel(id))
		wantOneSuccess(t, errs)
		f.wantConserved(t, 10, p, src, dst, id)
	})
	t.Run("two-transfers-oversell-same-source", func(t *testing.T) {
		src, dst := loc{"outlet", trOutletSrc}, loc{"warehouse", trWarehouseDst}
		p := f.product()
		f.setStock(src, p, 10)
		a, b := f.draft(src, dst, p, 6), f.draft(src, dst, p, 6)
		errs := f.race(t, stockTable(src), f.send(a), f.send(b))
		wantOneSuccess(t, errs)
		if got := f.stock(src, p); got != 4 {
			t.Errorf("source stock %d, want 4 (one send of 6 from 10; never negative)", got)
		}
	})
	t.Run("two-transfers-enough-stock-both-succeed", func(t *testing.T) {
		src, dst := loc{"outlet", trOutletSrc}, loc{"warehouse", trWarehouseDst}
		p := f.product()
		f.setStock(src, p, 20)
		a, b := f.draft(src, dst, p, 6), f.draft(src, dst, p, 6)
		errs := f.race(t, stockTable(src), f.send(a), f.send(b))
		for i, e := range errs {
			if e != nil {
				t.Errorf("send %d failed: %v", i, e)
			}
		}
		if got := f.stock(src, p); got != 8 {
			t.Errorf("source stock %d, want 8", got)
		}
		f.wantDocs(t, "surat_jalan_no", 2, a, b)
	})
}

const (
	trOutletSrc    = "00000000-0000-4000-8900-000000000001"
	trOutletDst    = "00000000-0000-4000-8900-000000000002"
	trWarehouseSrc = "00000000-0000-4000-8900-000000000003"
	trWarehouseDst = "00000000-0000-4000-8900-000000000004"
)

type loc struct{ kind, id string }

type trFixture struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	repo     *write.Repo
	products int
}

func stockTable(l loc) string {
	if l.kind == "outlet" {
		return "outlet_variant_stock"
	}
	return "warehouse_variant_stock"
}

func stockKey(l loc) string {
	if l.kind == "outlet" {
		return "outlet_id"
	}
	return "warehouse_id"
}

func (f *trFixture) sourceDest(srcKind string) (loc, loc) {
	if srcKind == "outlet" {
		return loc{"outlet", trOutletSrc}, loc{"warehouse", trWarehouseDst}
	}
	return loc{"warehouse", trWarehouseSrc}, loc{"outlet", trOutletDst}
}

func (f *trFixture) exec(sql string, args ...any) {
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		panic(err)
	}
}

func (f *trFixture) must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *trFixture) product() string {
	f.products++
	id := fmt.Sprintf("00000000-0000-4000-8901-%012d", f.products)
	f.exec(`INSERT INTO products(id,name) VALUES($1,$2)`, id, "TR product "+id)
	return id
}

func (f *trFixture) setStock(l loc, product string, qty int) {
	f.exec(fmt.Sprintf(`INSERT INTO %s(%s,product_id,variant_size,stock) VALUES($1,$2,'M',$3)
		ON CONFLICT (%s,product_id,variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
		stockTable(l), stockKey(l), stockKey(l)), l.id, product, qty)
}

func (f *trFixture) stock(l loc, product string) int {
	var n int
	err := f.pool.QueryRow(f.ctx, fmt.Sprintf(`SELECT COALESCE((SELECT stock FROM %s WHERE %s=$1 AND product_id=$2 AND variant_size='M'),0)`,
		stockTable(l), stockKey(l)), l.id, product).Scan(&n)
	if err != nil {
		panic(err)
	}
	return n
}

func (f *trFixture) draft(src, dst loc, product string, qty int) string {
	id, err := f.repo.CreateTransfer(f.ctx, "", write.TransferCreate{
		Source: write.TransferLoc{Kind: src.kind, ID: src.id},
		Dest:   write.TransferLoc{Kind: dst.kind, ID: dst.id},
		Items:  []write.TransferItemInput{{ProductID: product, VariantSize: "M", Qty: qty}},
	})
	if err != nil {
		panic(err)
	}
	return id
}

func (f *trFixture) send(id string) func(context.Context) error {
	return func(ctx context.Context) error { return f.repo.SendTransfer(ctx, id) }
}

func (f *trFixture) cancel(id string) func(context.Context) error {
	return func(ctx context.Context) error { return f.repo.CancelTransfer(ctx, id) }
}

func (f *trFixture) receive(id string) func(context.Context) error {
	return func(ctx context.Context) error {
		return f.repo.ReceiveTransfer(ctx, id, write.TransferReceive{}, write.ReceiveMeta{ReceivedVia: "backoffice"})
	}
}

// blockedSessions counts backends in this database currently waiting on a heavyweight lock.
func (f *trFixture) blockedSessions() int {
	var n int
	err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM pg_stat_activity
		WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&n)
	if err != nil {
		panic(err)
	}
	return n
}

// race starts the operations one at a time while a third session holds an
// EXCLUSIVE lock on table. After starting operation i it waits until
// (blocked sessions + finished operations) >= i+1, i.e. that operation is
// either parked on a lock or already done, so the ordering is the same on every
// run and for both unfixed code (parks on the stock write) and fixed code
// (parks on the transfer row lock). Then the lock is released.
func (f *trFixture) race(t *testing.T, table string, ops ...func(context.Context) error) []error {
	t.Helper()
	gate, err := f.pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	if _, err = gate.Exec(f.ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			if _, e := gate.Exec(f.ctx, "COMMIT"); e != nil {
				t.Error(e)
			}
		}
	}
	defer release()
	if _, err = gate.Exec(f.ctx, "LOCK TABLE "+table+" IN EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	errs := make([]error, len(ops))
	var done atomic.Int32
	var wg sync.WaitGroup
	for i, op := range ops {
		wg.Add(1)
		go func(i int, op func(context.Context) error) {
			defer wg.Done()
			errs[i] = op(f.ctx)
			done.Add(1)
		}(i, op)
		deadline := time.Now().Add(15 * time.Second)
		for f.blockedSessions()+int(done.Load()) < i+1 {
			if time.Now().After(deadline) {
				release()
				wg.Wait()
				t.Fatalf("operation %d neither blocked nor finished within 15s", i)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	release()
	wg.Wait()
	return errs
}

func wantOneSuccess(t *testing.T, errs []error) {
	t.Helper()
	ok := 0
	for _, e := range errs {
		if e == nil {
			ok++
		}
	}
	if ok != 1 {
		t.Errorf("want exactly one success, got %d (errors: %v)", ok, errs)
	}
}

func (f *trFixture) wantStatus(t *testing.T, id, want string) {
	t.Helper()
	var got string
	f.must(t, f.pool.QueryRow(f.ctx, `SELECT status FROM transfers WHERE id=$1`, id).Scan(&got))
	if got != want {
		t.Errorf("status %q, want %q", got, want)
	}
}

// wantDocs asserts how many of the transfers carry a document number and that they are distinct.
func (f *trFixture) wantDocs(t *testing.T, column string, want int, ids ...string) {
	t.Helper()
	var n, distinct int
	f.must(t, f.pool.QueryRow(f.ctx,
		`SELECT count(`+column+`), count(DISTINCT `+column+`) FROM transfers WHERE id = ANY($1)`, ids).Scan(&n, &distinct))
	if n != want || distinct != want {
		t.Errorf("%s: %d numbers (%d distinct), want %d distinct", column, n, distinct, want)
	}
}

// wantConserved: source + dest + in-transit quantity must equal the starting stock.
func (f *trFixture) wantConserved(t *testing.T, start int, product string, src, dst loc, id string) {
	t.Helper()
	var inTransit int
	f.must(t, f.pool.QueryRow(f.ctx,
		`SELECT COALESCE(sum(i.sent_qty),0) FROM transfer_items i JOIN transfers x ON x.id=i.transfer_id
		  WHERE x.id=$1 AND x.status='in_transit'`, id).Scan(&inTransit))
	if total := f.stock(src, product) + f.stock(dst, product) + inTransit; total != start {
		t.Errorf("stock not conserved: source %d + dest %d + in-transit %d = %d, want %d",
			f.stock(src, product), f.stock(dst, product), inTransit, total, start)
	}
}
