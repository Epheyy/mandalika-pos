package handlers

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp"
)

// countingCreator counts the POSTs the real outlet-create client sends to the stub.
type countingCreator struct {
	inner erp.OutletCreator
	calls int
}

func (c *countingCreator) CreateOutlet(ctx context.Context, in erp.OutletCreate) (erp.OutletCreateResult, erp.OutletCreateOutcome, string, error) {
	c.calls++
	return c.inner.CreateOutlet(ctx, in)
}

func erWithPusher(e *erEnv) *countingCreator {
	c := &countingCreator{inner: erp.NewOutletCreateClient(e.hs.URL+"/api/integration/v1", erKey, 0)}
	e.syncer.Pusher = c
	return c
}

// erPushSubtests are subtests of TestErpIntegrationPostgres (outlet push, POS to ERP).
func erPushSubtests(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Run("push-links-unlinked-active-outlets", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		pc := erWithPusher(e)
		gancit := erPosOutlet(t, ctx, pool, "Gancit POS", "GANCIT", "Jl. Gancit 1", "0812", "")
		test1 := erPosOutlet(t, ctx, pool, "Test One", "TEST1", "", "", "")
		bad := erPosOutlet(t, ctx, pool, "Bad Code", "X", "", "", "")
		erPosOutlet(t, ctx, pool, "BSD POS", "BSD", "", "", "bsd")
		kmg := erPosOutlet(t, ctx, pool, "Kemang POS", "KMG", "", "", "")
		if _, err := pool.Exec(ctx, `UPDATE outlets SET is_active=false WHERE id=$1`, test1); err != nil {
			t.Fatal(err)
		}
		e.outlet("bsd", "BSD", "BSD", "")
		e.outlet("kmg", "KMG", "Mandalika Kemang", "")

		rep := e.mustComplete(erp.ModeFull)
		erWantInt(t, "exactly one POST", pc.calls, 1)
		if rep.OutletPush == nil || rep.OutletPush.Attempted != 1 || rep.OutletPush.Linked != 1 || rep.OutletPush.Status != erp.PushCompleted {
			t.Fatalf("push result = %+v", rep.OutletPush)
		}
		erWant(t, "GANCIT link", erStr(t, ctx, pool, `SELECT erp_slug||'|'||erp_code FROM outlets WHERE id=$1`, gancit), "gancit|GANCIT")
		erWant(t, "KMG linked by the pull", erStr(t, ctx, pool, `SELECT erp_slug FROM outlets WHERE id=$1`, kmg), "kmg")
		erWant(t, "TEST1 untouched", erStr(t, ctx, pool, `SELECT erp_slug FROM outlets WHERE id=$1`, test1), "<NULL>")
		erWant(t, "X untouched", erStr(t, ctx, pool, `SELECT erp_slug FROM outlets WHERE id=$1`, bad), "<NULL>")
		// The pull bumps `outlets` once (KMG link); the push bumps it again.
		erWant(t, "outlets content version bumped by pull and push", erStr(t, ctx, pool,
			`SELECT data_manifest->>'outlets' FROM content_versions WHERE outlet_id=$1`, gancit), "2")

		before := erVersion(t, ctx, pool)
		e.clock.Advance(time.Hour)
		rep = e.mustComplete(erp.ModeFull)
		erWantInt(t, "second run sends no POST", pc.calls, 1)
		if rep.OutletPush == nil || rep.OutletPush.Attempted != 0 {
			t.Fatalf("second push result = %+v", rep.OutletPush)
		}
		erWant(t, "second run is a no-op", erVersion(t, ctx, pool), before)
	})

	t.Run("push-after-pull-links-existing-erp-outlet", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		pc := erWithPusher(e)
		gancit := erPosOutlet(t, ctx, pool, "Gancit POS", "GANCIT", "", "", "")
		e.outlet("gancit", "GANCIT", "Gancit ERP", "") // created earlier, reply lost
		rep := e.mustComplete(erp.ModeFull)
		erWantInt(t, "no POST: the pull linked it", pc.calls, 0)
		erWant(t, "linked by the pull", erStr(t, ctx, pool, `SELECT erp_slug FROM outlets WHERE id=$1`, gancit), "gancit")
		if rep.OutletPush == nil || rep.OutletPush.Attempted != 0 {
			t.Fatalf("push result = %+v", rep.OutletPush)
		}
	})
}
