package handlers

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// A15 Phase B: per-outlet stock change counter (outlet_stock_seq). Opt-in only, same
// isolation contract as the other PostgreSQL gates (MANDALIKA_ST_TEST_DSN, fresh
// synthetic cluster on port 56458). The counter must move EXACTLY once per committing
// stock-changing transaction (delta == 1, never >= 1), never for a transaction that
// leaves stock unchanged or rolls back, and never for a replayed key.
const (
	stOutletA = "00000000-0000-4000-8f58-00000000000a"
	stOutletB = "00000000-0000-4000-8f58-00000000000b"
)

type stFixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	repo   *write.Repo
	svc    *service.OrderService
	h      *Handlers
	router http.Handler
	token  string
}

func (f *stFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

// seq reads an outlet's counter; an outlet without a row reads 0.
func (f *stFixture) seq(t *testing.T, outlet string) int64 {
	t.Helper()
	var n int64
	err := f.pool.QueryRow(f.ctx, `SELECT COALESCE((SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1),0)`, outlet).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestStockSeqPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "ST", 56458)
	f := &stFixture{ctx: ctx, pool: pool}
	f.exec(t, `INSERT INTO outlets(id,name) VALUES($1,'ST outlet A'),($2,'ST outlet B')`, stOutletA, stOutletB)

	t.Run("T1 one bump is exactly +1 per outlet and the upsert creates the row", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		got, err := write.BumpStockSeq(ctx, tx, stOutletA, stOutletB, stOutletA)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[stOutletA] != 1 || got[stOutletB] != 1 {
			t.Fatalf("got %v, want each outlet at 1 (duplicates collapse)", got)
		}
		if f.seq(t, stOutletA) != 1 || f.seq(t, stOutletB) != 1 {
			t.Fatalf("A=%d B=%d", f.seq(t, stOutletA), f.seq(t, stOutletB))
		}
	})

	t.Run("T1 rollback consumes nothing", func(t *testing.T) {
		before := f.seq(t, stOutletA)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = write.BumpStockSeq(ctx, tx, stOutletA); err != nil {
			t.Fatal(err)
		}
		if err = tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if after := f.seq(t, stOutletA); after != before {
			t.Fatalf("seq %d -> %d after rollback", before, after)
		}
		tx2, _ := pool.Begin(ctx)
		got, err := write.BumpStockSeq(ctx, tx2, stOutletA)
		_ = tx2.Commit(ctx)
		if err != nil || got[stOutletA] != before+1 {
			t.Fatalf("next bump %v err=%v, want %d (no gap)", got, err, before+1)
		}
	})

	t.Run("T1 N concurrent bumps hand out exactly S+1..S+N", func(t *testing.T) {
		const n = 20
		start := f.seq(t, stOutletA)
		var mu sync.Mutex
		var seen []int64
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				tx, err := pool.Begin(ctx)
				if err != nil {
					errs <- err
					return
				}
				got, err := write.BumpStockSeq(ctx, tx, stOutletA)
				if err != nil {
					_ = tx.Rollback(ctx)
					errs <- err
					return
				}
				if err = tx.Commit(ctx); err != nil {
					errs <- err
					return
				}
				mu.Lock()
				seen = append(seen, got[stOutletA])
				mu.Unlock()
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		sort.Slice(seen, func(i, j int) bool { return seen[i] < seen[j] })
		for i, v := range seen {
			if v != start+int64(i)+1 {
				t.Fatalf("seq set %v, want %d..%d contiguous", seen, start+1, start+n)
			}
		}
		if f.seq(t, stOutletA) != start+n {
			t.Fatalf("final %d want %d", f.seq(t, stOutletA), start+n)
		}
	})

	t.Run("T1 a held transaction: a reader that saw S sees more once it commits", func(t *testing.T) {
		s := f.seq(t, stOutletB)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = write.BumpStockSeq(ctx, tx, stOutletB); err != nil {
			t.Fatal(err)
		}
		if got := f.seq(t, stOutletB); got != s {
			t.Fatalf("uncommitted bump visible: %d vs %d", got, s)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if got := f.seq(t, stOutletB); got <= s {
			t.Fatalf("after commit %d, want > %d", got, s)
		}
	})

	t.Run("T1 two outlets in opposite argument order never deadlock", func(t *testing.T) {
		a0, b0 := f.seq(t, stOutletA), f.seq(t, stOutletB)
		const pairs = 20
		var wg sync.WaitGroup
		errs := make(chan error, 2*pairs)
		for i := 0; i < pairs; i++ {
			for _, order := range [][]string{{stOutletA, stOutletB}, {stOutletB, stOutletA}} {
				order := order
				wg.Add(1)
				go func() {
					defer wg.Done()
					var tx pgx.Tx
					tx, err := pool.Begin(ctx)
					if err != nil {
						errs <- err
						return
					}
					if _, err = write.BumpStockSeq(ctx, tx, order...); err != nil {
						_ = tx.Rollback(ctx)
						errs <- err
						return
					}
					errs <- tx.Commit(ctx)
				}()
			}
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("deadlock or failure: %v", err)
			}
		}
		if f.seq(t, stOutletA) != a0+2*pairs || f.seq(t, stOutletB) != b0+2*pairs {
			t.Fatalf("A %d->%d B %d->%d", a0, f.seq(t, stOutletA), b0, f.seq(t, stOutletB))
		}
	})

	f.initWriters(t)
	f.runWriterCases(t)
}
