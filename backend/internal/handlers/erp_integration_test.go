package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/integration/erp/erpstub"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
)

// Step 4 ERP catalog pull (plan §4.6, gate ER): the real erp.Client and erp.Syncer run
// against the in-process erpstub and a real PostgreSQL. Opt-in only, same isolation
// contract as the other gates (MANDALIKA_ER_TEST_DSN, synthetic cluster on port 56468).
// Every subtest resets the catalog tables and starts its own stub, so any one runs
// alone with -run TestErpIntegrationPostgres/<name>.

const erKey = "er-test-key"

// erTransport records every request and lets a test intercept before it is sent.
type erTransport struct {
	mu     sync.Mutex
	reqs   []*http.Request
	before func(*http.Request)
}

func (tr *erTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	tr.mu.Lock()
	tr.reqs = append(tr.reqs, r.Clone(context.Background()))
	f := tr.before
	tr.mu.Unlock()
	if f != nil {
		f(r)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func (tr *erTransport) fgRequests() []*http.Request {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	var out []*http.Request
	for _, r := range tr.reqs {
		if strings.HasSuffix(r.URL.Path, "/catalog/finished-goods") {
			out = append(out, r)
		}
	}
	return out
}

type erEnv struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	hs     *httptest.Server
	tr     *erTransport
	client *erp.Client
	syncer *erp.Syncer
	clock  *erClock
}

type erClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *erClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *erClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func erReset(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `TRUNCATE products, categories, outlets, integration_watermarks, erp_sync_runs CASCADE`); err != nil {
		t.Fatal(err)
	}
}

func newErEnv(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pageSize int) *erEnv {
	t.Helper()
	erReset(t, ctx, pool)
	clock := &erClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	stub, err := erpstub.New(erpstub.Config{
		Key: erKey, Now: clock.Now,
		Seed: []byte(`{"finished_goods":[],"outlets":[],"warehouses":[]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(stub)
	t.Cleanup(hs.Close)
	tr := &erTransport{}
	client, err := erp.NewClient(erp.ClientOptions{
		BaseURL: hs.URL + "/api/integration/v1", APIKey: erKey,
		HTTPClient:  &http.Client{Transport: tr, Timeout: 10 * time.Second},
		MaxAttempts: 1,
		Sleep:       func(context.Context, time.Duration) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &erEnv{t: t, ctx: ctx, pool: pool, hs: hs, tr: tr, client: client, clock: clock,
		syncer: &erp.Syncer{Pool: pool, Source: client, PageSize: pageSize}}
}

func (e *erEnv) hook(path, body string) {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.hs.URL+path, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+erKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("hook %s -> %d", path, resp.StatusCode)
	}
}

// fg upserts a finished good in the stub. size 0 means no size; extra is raw JSON
// members appended (e.g. `,"deleted_at":"..."`).
func (e *erEnv) fg(slug, code, name, category string, size int, status, extra string) {
	e.t.Helper()
	sz := "null"
	if size > 0 {
		sz = fmt.Sprint(size)
	}
	e.hook("/_stub/fg", fmt.Sprintf(`{"slug":%q,"code":%q,"name":%q,"category":%q,"size":%s,"status":%q%s}`,
		slug, code, name, category, sz, status, extra))
}

func (e *erEnv) outlet(slug, code, name, extra string) {
	e.t.Helper()
	e.hook("/_stub/outlet", fmt.Sprintf(`{"slug":%q,"code":%q,"name":%q%s}`, slug, code, name, extra))
}

func (e *erEnv) run(mode erp.Mode) erp.CatalogReport {
	e.t.Helper()
	rep, err := e.syncer.Run(e.ctx, mode)
	if err != nil {
		e.t.Fatal(err)
	}
	return rep
}

func (e *erEnv) mustComplete(mode erp.Mode) erp.CatalogReport {
	e.t.Helper()
	rep := e.run(mode)
	if rep.Status != erp.StatusCompleted {
		e.t.Fatalf("run status = %s, report %+v", rep.Status, rep.Resources)
	}
	return rep
}

func (e *erEnv) resource(rep erp.CatalogReport, name string) erp.ResourceResult {
	for _, r := range rep.Resources {
		if r.Resource == name {
			return r
		}
	}
	e.t.Fatalf("no %s result in %+v", name, rep)
	return erp.ResourceResult{}
}

func erCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func erStr(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	var s *string
	if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	if s == nil {
		return "<NULL>"
	}
	return *s
}

func erWant(t *testing.T, what, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %q, want %q", what, got, want)
	}
}

func erWantInt(t *testing.T, what string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %d, want %d", what, got, want)
	}
}

func erVersion(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	return erStr(t, ctx, pool, `SELECT string_agg(version::text, ',' ORDER BY outlet_id) FROM content_versions`)
}

func TestErpIntegrationPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "ER", 56468)

	t.Run("full-run-empty-pos", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.outlet("bsd", "BSD", "Mandalika BSD", "")
		e.fg("x30", "X30", "Santal Noir 30ml", "Eau de Parfum", 30, "ACTIVE", "")
		e.fg("x50", "X50", "Santal Noir 50ml", "Eau de Parfum", 50, "ACTIVE", "")
		rep := e.mustComplete(erp.ModeFull)

		erWantInt(t, "outlets", erCount(t, ctx, pool, `SELECT count(*) FROM outlets WHERE NOT is_active AND code IS NULL AND erp_slug IS NOT NULL AND erp_code IS NOT NULL`), 2)
		erWantInt(t, "outlet total", erCount(t, ctx, pool, `SELECT count(*) FROM outlets`), 2)
		erWantInt(t, "content_versions rows", erCount(t, ctx, pool, `SELECT count(*) FROM content_versions`), 2)
		erWant(t, "outlet erp_code", erStr(t, ctx, pool, `SELECT erp_code FROM outlets WHERE erp_slug='kemang'`), "KMG")
		erWantInt(t, "products", erCount(t, ctx, pool, `SELECT count(*) FROM products`), 1)
		erWant(t, "group key", erStr(t, ctx, pool, `SELECT erp_group_key FROM products`), "pos:santal noir")
		erWant(t, "product name", erStr(t, ctx, pool, `SELECT name FROM products`), "Santal Noir")
		erWantInt(t, "sellable products", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE sellable`), 0)
		erWant(t, "sizes", erStr(t, ctx, pool, `SELECT string_agg(size, ',' ORDER BY size) FROM product_variants`), "30ml,50ml")
		erWantInt(t, "variant shape", erCount(t, ctx, pool,
			`SELECT count(*) FROM product_variants WHERE sku=barcode AND sku IN ('X30','X50') AND price=0 AND erp_slug IS NOT NULL AND is_active`), 2)
		erWantInt(t, "products content-version bump", erCount(t, ctx, pool, `SELECT count(*) FROM content_versions WHERE data_manifest ? 'products' AND data_manifest ? 'outlets'`), 2)

		wm := erStr(t, ctx, pool, `SELECT to_char(watermark AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM integration_watermarks WHERE resource='finished_goods'`)
		erWant(t, "fg watermark = first-page server_time", wm, e.clock.Now().Format(time.RFC3339))
		erWantInt(t, "completed runs", erCount(t, ctx, pool, `SELECT count(*) FROM erp_sync_runs WHERE status='completed' AND finished_at IS NOT NULL AND mode='full'`), 2)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Watermark == nil || r.Upserted != 2 {
			t.Fatalf("fg result = %+v", r)
		}
	})

	t.Run("link-existing-outlet-by-code", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		if _, err := pool.Exec(ctx, `INSERT INTO outlets (name, code) VALUES ('Kemang POS','kmg')`); err != nil {
			t.Fatal(err)
		}
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.mustComplete(erp.ModeFull)
		erWantInt(t, "outlet rows", erCount(t, ctx, pool, `SELECT count(*) FROM outlets`), 1)
		erWant(t, "erp_slug", erStr(t, ctx, pool, `SELECT erp_slug FROM outlets`), "kemang")
		erWant(t, "erp_code", erStr(t, ctx, pool, `SELECT erp_code FROM outlets`), "KMG")
		erWant(t, "POS code untouched", erStr(t, ctx, pool, `SELECT code FROM outlets`), "kmg")

		before := erVersion(t, ctx, pool)
		e.clock.Advance(time.Hour)
		e.mustComplete(erp.ModeFull)
		erWant(t, "content version after no-op rerun", erVersion(t, ctx, pool), before)
	})

	t.Run("incremental-updates-and-discontinue", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("a30", "A30", "Alpha 30ml", "EDP", 30, "ACTIVE", "")
		e.fg("a50", "A50", "Alpha 50ml", "EDP", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		w0 := e.clock.Now()

		e.clock.Advance(time.Hour)
		e.fg("a30", "A30", "Alpha Prime 30ml", "Parfum", 30, "DISCONTINUE", "")
		rep := e.mustComplete(erp.ModeIncremental)

		reqs := e.tr.fgRequests()
		last := reqs[len(reqs)-1]
		erWant(t, "updated_since", last.URL.Query().Get("updated_since"), w0.Add(-5*time.Minute).Format(time.RFC3339))
		// The live sibling a50 owns the product now, so the discontinued a30's rename and
		// recategorisation do not reach it (owner rule; a live owner's rename is covered in
		// one-fragrance-across-categories). The unused new category is not created.
		erWant(t, "product name", erStr(t, ctx, pool, `SELECT name FROM products`), "Alpha")
		erWant(t, "category", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "EDP")
		erWantInt(t, "unused category not created", erCount(t, ctx, pool, `SELECT count(*) FROM categories WHERE name='Parfum'`), 0)
		erWantInt(t, "a30 inactive", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='a30' AND NOT is_active AND size='30ml'`), 1)
		erWantInt(t, "a50 still active", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='a50' AND is_active`), 1)
		erWantInt(t, "product active (a50 is)", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 1)
		wm := erStr(t, ctx, pool, `SELECT to_char(watermark AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM integration_watermarks WHERE resource='finished_goods'`)
		erWant(t, "watermark advanced", wm, e.clock.Now().Format(time.RFC3339))
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Mode != erp.ModeIncremental || r.Upserted != 2 { // a50 is re-read through the 5-minute overlap
			t.Fatalf("fg result = %+v", r)
		}
	})

	t.Run("never-touch-size-or-stock", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("b30", "B30", "Beta 30ml", "EDP", 30, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		if _, err := pool.Exec(ctx, `INSERT INTO outlets (name, code) VALUES ('Shop','SHP')`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			SELECT (SELECT id FROM outlets), product_id, size, 7 FROM product_variants WHERE erp_slug='b30'`); err != nil {
			t.Fatal(err)
		}
		e.clock.Advance(time.Hour)
		e.fg("b30", "B30", "Beta 100ml", "EDP", 100, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		erWant(t, "size unchanged", erStr(t, ctx, pool, `SELECT size FROM product_variants WHERE erp_slug='b30'`), "30ml")
		erWant(t, "stock row unchanged", erStr(t, ctx, pool, `SELECT variant_size||':'||stock FROM outlet_variant_stock`), "30ml:7")
		erWantInt(t, "no extra variants", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants`), 1)
	})

	// Regression (ERP local pull 2026-10-23): sizes of one fragrance filed under different
	// ERP categories with stock unit Pcs became one product per category, sized "110pcs".
	t.Run("one-fragrance-across-categories", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "") // content_versions has one row per outlet
		// Slugs page SN110 first, so the owner (lowest code) is not the FG that created the product.
		e.fg("b-sn030", "SN030", "Santal Noir 30ml", "EDP 30", 30, "ACTIVE", `,"unit":"Pcs"`)
		e.fg("a-sn110", "SN110", "Santal Noir 110ml", "EDP 110", 110, "ACTIVE", `,"unit":"Pcs"`)
		e.mustComplete(erp.ModeFull)
		erWantInt(t, "products", erCount(t, ctx, pool, `SELECT count(*) FROM products`), 1)
		erWant(t, "group key", erStr(t, ctx, pool, `SELECT erp_group_key FROM products`), "pos:santal noir")
		erWant(t, "sizes", erStr(t, ctx, pool, `SELECT string_agg(size, ',' ORDER BY size) FROM product_variants`), "110ml,30ml")
		erWant(t, "category of the lowest FG code", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "EDP 30")

		before := erVersion(t, ctx, pool)
		if before == "" {
			t.Fatal("no content version to compare")
		}
		for i := 0; i < 2; i++ {
			e.clock.Advance(time.Hour)
			e.mustComplete(erp.ModeFull)
		}
		erWant(t, "content version after reruns", erVersion(t, ctx, pool), before)
		erWant(t, "category stable", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "EDP 30")

		e.clock.Advance(time.Hour)
		e.fg("a-sn110", "SN110", "Santal Noir Intense 110ml", "EDP 110", 110, "ACTIVE", `,"unit":"Pcs"`)
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "a non-owner sibling does not rename the product", erStr(t, ctx, pool, `SELECT name FROM products`), "Santal Noir")
		erWant(t, "version unchanged by the non-owner", erVersion(t, ctx, pool), before)

		erWant(t, "each size stores what the ERP said", erStr(t, ctx, pool,
			`SELECT string_agg(erp_name||'/'||erp_category, ',' ORDER BY sku) FROM product_variants`), "Santal Noir/EDP 30,Santal Noir Intense/EDP 110")

		// A discontinued owner hands over to the next live size in the same pull, although
		// that size is not in this incremental page.
		e.clock.Advance(time.Hour)
		e.fg("b-sn030", "SN030", "Santal Noir 30ml", "EDP 30", 30, "DISCONTINUE", `,"unit":"Pcs"`)
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "live size owns the name at once", erStr(t, ctx, pool, `SELECT name FROM products`), "Santal Noir Intense")
		erWant(t, "live size owns the category at once", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "EDP 110")
		if after := erVersion(t, ctx, pool); after == before {
			t.Fatal("the hand-over must bump the content version")
		}
	})

	// A full run that no longer lists the owner deactivates it (reconcile) and hands the
	// product over to the next size in the same transaction.
	t.Run("reconcile-hands-over-owner", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.fg("h1", "H1", "Eta 30ml", "Cat A", 30, "ACTIVE", "")
		e.fg("h2", "H2", "Eta 50ml", "Cat B", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		erWant(t, "owner category", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "Cat A")
		before := erVersion(t, ctx, pool)

		e.clock.Advance(time.Hour)
		e.fg("h1", "H1", "Eta 30ml", "Cat A", 30, "ACTIVE", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		rep := e.mustComplete(erp.ModeFull)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Deactivated != 1 {
			t.Fatalf("deactivated = %d", r.Deactivated)
		}
		erWant(t, "category handed over by reconcile", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "Cat B")
		erWantInt(t, "product still active", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 1)
		if erVersion(t, ctx, pool) == before {
			t.Fatal("the reconcile hand-over must bump the content version")
		}
	})

	// Rows created before migration 0068 have no stored values. Until the owner's row is
	// stored, an incremental pull of a lower-ranked size must not rename the product.
	t.Run("legacy-rows-keep-product-until-owner-stored", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.fg("l1", "L1", "Lambda 30ml", "Cat A", 30, "ACTIVE", "")
		e.fg("l2", "L2", "Lambda 50ml", "Cat B", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET erp_name=NULL, erp_category=NULL`); err != nil {
			t.Fatal(err)
		}
		before := erVersion(t, ctx, pool)

		e.clock.Advance(time.Hour)
		e.fg("l2", "L2", "Lambda Noir 50ml", "Cat B", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "name kept while the owner is unstored", erStr(t, ctx, pool, `SELECT name FROM products`), "Lambda")
		erWant(t, "category kept while the owner is unstored", erStr(t, ctx, pool, `SELECT c.name FROM products p JOIN categories c ON c.id=p.category_id`), "Cat A")
		erWant(t, "no version bump", erVersion(t, ctx, pool), before)
		erWant(t, "the pulled size is stored", erStr(t, ctx, pool, `SELECT erp_name FROM product_variants WHERE sku='L2'`), "Lambda Noir")

		e.clock.Advance(time.Hour)
		e.mustComplete(erp.ModeFull)
		erWant(t, "owner stored by the full pull", erStr(t, ctx, pool, `SELECT erp_name||'/'||erp_category FROM product_variants WHERE sku='L1'`), "Lambda/Cat A")
		erWant(t, "product follows the owner", erStr(t, ctx, pool, `SELECT name FROM products`), "Lambda")
	})

	// Category is only a tie-breaker: one name in two product lines that share a size.
	t.Run("name-collision-tie-breaker", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("d100", "D100", "Dune 100ml", "Eau de Parfum", 100, "ACTIVE", "")
		e.fg("m100", "M100", "Dune 100ml", "Body Mist", 100, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		e.clock.Advance(time.Hour)
		e.fg("m200", "M200", "Dune 200ml", "Body Mist", 200, "ACTIVE", "")
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "group keys", erStr(t, ctx, pool, `SELECT string_agg(erp_group_key, ',' ORDER BY erp_group_key) FROM products`),
			"pos:dune,pos:dune|body mist")
		erWant(t, "body mist sizes", erStr(t, ctx, pool, `SELECT string_agg(v.size, ',' ORDER BY v.size) FROM product_variants v
			JOIN products p ON p.id=v.product_id WHERE p.erp_group_key='pos:dune|body mist'`), "100ml,200ml")
		erWant(t, "edp sizes", erStr(t, ctx, pool, `SELECT string_agg(v.size, ',') FROM product_variants v
			JOIN products p ON p.id=v.product_id WHERE p.erp_group_key='pos:dune'`), "100ml")
	})

	t.Run("tombstone", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("t30", "T30", "Tau 30ml", "EDP", 30, "ACTIVE", "")
		e.fg("t50", "T50", "Tau 50ml", "EDP", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)

		e.clock.Advance(time.Hour)
		e.fg("t30", "T30", "Tau 30ml", "EDP", 30, "ACTIVE", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		rep := e.mustComplete(erp.ModeIncremental)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Tombstoned != 1 {
			t.Fatalf("tombstoned = %d", r.Tombstoned)
		}
		erWantInt(t, "t30 inactive", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='t30' AND NOT is_active`), 1)
		erWantInt(t, "product still active", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 1)

		e.clock.Advance(time.Hour)
		e.fg("t50", "T50", "Tau 50ml", "EDP", 50, "ACTIVE", `,"deleted_at":"2026-06-01T01:30:00Z"`)
		e.mustComplete(erp.ModeIncremental)
		erWantInt(t, "product inactive when all variants are", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 0)
		erWantInt(t, "nothing hard-deleted: variants", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants`), 2)
		erWantInt(t, "nothing hard-deleted: products", erCount(t, ctx, pool, `SELECT count(*) FROM products`), 1)
	})

	t.Run("outlet-code-change-follows-404", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		if _, err := pool.Exec(ctx, `INSERT INTO outlets (name, code) VALUES ('Kemang POS','kmg')`); err != nil {
			t.Fatal(err)
		}
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.mustComplete(erp.ModeFull)

		e.clock.Advance(time.Hour)
		e.outlet("kemang", "KMG2", "Mandalika Kemang", "")
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "POS code untouched", erStr(t, ctx, pool, `SELECT code FROM outlets`), "kmg")
		erWant(t, "erp_code updated", erStr(t, ctx, pool, `SELECT erp_code FROM outlets`), "KMG2")

		_, cur, err := e.client.OutletStockBySlug(ctx, "kemang", "KMG", nil)
		if err != nil {
			t.Fatal(err)
		}
		erWant(t, "code that worked after the 404", cur, "KMG2")
	})

	t.Run("interrupted-run-keeps-watermark", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 2)
		for i, n := range []string{"i1", "i2", "i3"} {
			e.fg(n, strings.ToUpper(n), "Iota "+n, "Cat"+fmt.Sprint(i), 0, "ACTIVE", "")
		}
		e.fg("gone", "GONE", "Gone", "Cat", 0, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		w0 := erStr(t, ctx, pool, `SELECT watermark::text FROM integration_watermarks WHERE resource='finished_goods'`)

		e.clock.Advance(time.Hour)
		e.fg("gone", "GONE", "Gone", "Cat", 0, "ACTIVE", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		// Fail the second finished-goods page: arm the stub fault just before it is requested.
		e.tr.mu.Lock()
		e.tr.before = func(r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/catalog/finished-goods") && r.URL.Query().Get("cursor") != "" {
				e.hook("/_stub/fault?status=503&count=5", `{}`)
			}
		}
		e.tr.mu.Unlock()
		rep := e.run(erp.ModeFull)
		if rep.Status != erp.StatusFailed {
			t.Fatalf("status = %s, want failed; %+v", rep.Status, rep.Resources)
		}
		erWant(t, "watermark not advanced", erStr(t, ctx, pool, `SELECT watermark::text FROM integration_watermarks WHERE resource='finished_goods'`), w0)
		erWant(t, "last_status", erStr(t, ctx, pool, `SELECT last_status FROM integration_watermarks WHERE resource='finished_goods'`), "failed")
		erWantInt(t, "no reconcile: absent FG stays active", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='gone' AND is_active`), 1)
		erWantInt(t, "failed run row", erCount(t, ctx, pool, `SELECT count(*) FROM erp_sync_runs WHERE resource='finished_goods' AND status='failed' AND finished_at IS NOT NULL`), 1)
	})

	t.Run("full-reconcile", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("r1", "R1", "Rho One", "EDP", 0, "ACTIVE", "")
		e.fg("r2", "R2", "Rho Two", "EDP", 0, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)

		e.clock.Advance(time.Hour)
		e.fg("r2", "R2", "Rho Two", "EDP", 0, "ACTIVE", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		rep := e.mustComplete(erp.ModeFull)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Deactivated != 1 {
			t.Fatalf("deactivated = %d", r.Deactivated)
		}
		erWantInt(t, "r2 inactive", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='r2' AND NOT is_active`), 1)
		erWantInt(t, "r1 active", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='r1' AND is_active`), 1)

		// An empty full catalog is an ERP fault, not "everything was removed".
		e.clock.Advance(time.Hour)
		e.fg("r1", "R1", "Rho One", "EDP", 0, "ACTIVE", `,"deleted_at":"2026-06-01T01:30:00Z"`)
		rep = e.mustComplete(erp.ModeFull)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Deactivated != 0 {
			t.Fatalf("empty catalog deactivated = %d", r.Deactivated)
		}
		erWantInt(t, "r1 still active after empty full run", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='r1' AND is_active`), 1)
	})

	// Review M2: outlet reconcile only reports; deactivating an outlet locks its tablets out.
	t.Run("outlet-reconcile-is-report-only", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("o-keep", "OKP", "Keep", "")
		e.outlet("o-miss", "OMS", "Miss", "")
		e.mustComplete(erp.ModeFull)
		if _, err := pool.Exec(ctx, `UPDATE outlets SET is_active=true WHERE erp_slug IN ('o-keep','o-miss')`); err != nil {
			t.Fatal(err)
		}

		e.clock.Advance(time.Hour)
		e.outlet("o-miss", "OMS", "Miss", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		rep := e.mustComplete(erp.ModeFull)
		r := e.resource(rep, erp.ResourceOutlets)
		if r.Deactivated != 0 || !strings.Contains(r.Error, "report-only: 1 of 2") {
			t.Fatalf("outlet result = %+v, want a report-only note and nothing deactivated", r)
		}
		erWantInt(t, "missing outlet stays active", erCount(t, ctx, pool, `SELECT count(*) FROM outlets WHERE erp_slug='o-miss' AND is_active`), 1)
		erWantInt(t, "kept outlet active", erCount(t, ctx, pool, `SELECT count(*) FROM outlets WHERE erp_slug='o-keep' AND is_active`), 1)
	})

	t.Run("rp0-variant-hidden-from-pos-read", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		var catID, productID, outletID string
		if err := pool.QueryRow(ctx, `INSERT INTO categories (name) VALUES ('EDP') RETURNING id::text`).Scan(&catID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO products (name, category_id, sellable, erp_group_key)
			VALUES ('Gamma',$1,true,'pos:gamma') RETURNING id::text`, catID).Scan(&productID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO product_variants (product_id, size, price, sku) VALUES ($1,'50ml',100000,'G50')`, productID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO outlets (name, code) VALUES ('Shop','SHP') RETURNING id::text`).Scan(&outletID); err != nil {
			t.Fatal(err)
		}
		e.fg("g30", "G30", "Gamma 30ml", "EDP", 30, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		erWantInt(t, "joined the existing product", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE product_id=$1`, productID), 2)

		sizes := func() string {
			prods, _, err := read.New(pool).Products(ctx, read.Scope{OutletID: outletID, SellableOnly: true}, 1, 100)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, p := range prods {
				if p.Name == "Gamma" {
					for _, v := range p.Variants {
						out = append(out, v.Size)
					}
				}
			}
			return strings.Join(out, ",")
		}
		erWant(t, "POS read before pricing", sizes(), "50ml")
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET price=50000 WHERE erp_slug='g30'`); err != nil {
			t.Fatal(err)
		}
		erWant(t, "POS read after pricing", sizes(), "30ml,50ml")
	})

	t.Run("admin-deactivated-product-stays-inactive", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("p30", "P30", "Pi 30ml", "EDP", 30, "ACTIVE", "")
		e.fg("p50", "P50", "Pi 50ml", "EDP", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		if _, err := pool.Exec(ctx, `UPDATE products SET is_active=false`); err != nil {
			t.Fatal(err)
		}
		e.clock.Advance(time.Hour)
		e.mustComplete(erp.ModeFull)
		erWantInt(t, "admin deactivation survives a full run", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 0)
		erWantInt(t, "variants stay active", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE is_active`), 2)

		// Cleared when the last variant goes inactive; never set back on its own.
		e.clock.Advance(time.Hour)
		e.fg("p30", "P30", "Pi 30ml", "EDP", 30, "ACTIVE", `,"deleted_at":"2026-06-01T02:30:00Z"`)
		e.fg("p50", "P50", "Pi 50ml", "EDP", 50, "ACTIVE", `,"deleted_at":"2026-06-01T02:30:00Z"`)
		e.mustComplete(erp.ModeIncremental)
		erWantInt(t, "variants inactive", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE is_active`), 0)
		erWantInt(t, "product inactive", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 0)
		e.clock.Advance(time.Hour)
		e.fg("p30", "P30", "Pi 30ml", "EDP", 30, "ACTIVE", "")
		e.mustComplete(erp.ModeIncremental)
		erWantInt(t, "variant re-activated by the ERP", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='p30' AND is_active`), 1)
		erWantInt(t, "product not set back to active by the pull", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE is_active`), 0)
	})

	t.Run("backoffice-read-shows-hidden-variants", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("d30", "D30", "Delta 30ml", "EDP", 30, "ACTIVE", "")
		e.fg("d50", "D50", "Delta 50ml", "EDP", 50, "ACTIVE", "")
		e.mustComplete(erp.ModeFull)
		var outletID, productID string
		if err := pool.QueryRow(ctx, `INSERT INTO outlets (name, code) VALUES ('Shop','SHP') RETURNING id::text`).Scan(&outletID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `UPDATE products SET sellable=true RETURNING id::text`).Scan(&productID); err != nil {
			t.Fatal(err)
		}
		// d50 priced then discontinued (inactive); a POS-owned 100ml keeps the product visible.
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET price=50000 WHERE erp_slug='d50'`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO product_variants (product_id, size, price, sku) VALUES ($1,'100ml',90000,'D100')`, productID); err != nil {
			t.Fatal(err)
		}
		e.clock.Advance(time.Hour)
		e.fg("d50", "D50", "Delta 50ml", "EDP", 50, "DISCONTINUE", "")
		e.mustComplete(erp.ModeIncremental)

		sizes := func(sc read.Scope) string {
			prods, _, err := read.New(pool).Products(ctx, sc, 1, 100)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, p := range prods {
				if p.Name == "Delta" {
					for _, v := range p.Variants {
						out = append(out, v.Size)
					}
				}
			}
			return strings.Join(out, ",")
		}
		erWant(t, "backoffice outlet scope shows every variant", sizes(read.Scope{OutletID: outletID}), "100ml,30ml,50ml")
		erWant(t, "tablet pull hides inactive and Rp0 ERP variants", sizes(read.Scope{OutletID: outletID, SellableOnly: true}), "100ml")
		// R6: the resolved outlet price decides, not the base price.
		if _, err := pool.Exec(ctx, `INSERT INTO outlet_variant_price (outlet_id, product_id, variant_size, price) VALUES ($1,$2,'30ml',70000)`, outletID, productID); err != nil {
			t.Fatal(err)
		}
		erWant(t, "outlet price override un-hides the Rp0 base variant", sizes(read.Scope{OutletID: outletID, SellableOnly: true}), "100ml,30ml")
	})

	t.Run("500-fg-full-run-within-budget", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		for i := 0; i < 500; i++ {
			e.fg(fmt.Sprintf("perf-%03d", i), fmt.Sprintf("PF%03d", i), fmt.Sprintf("Perf Scent %03d", i), "EDP", 0, "ACTIVE", "")
		}
		start := time.Now()
		rep := e.mustComplete(erp.ModeFull)
		elapsed := time.Since(start)
		t.Logf("500-FG full run (create path) took %s", elapsed)
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Status != erp.StatusCompleted || r.Upserted != 500 || r.ItemErrors != 0 {
			t.Fatalf("fg result = %+v", r)
		}
		erWantInt(t, "variants", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants`), 500)
		if elapsed > 25*time.Second {
			t.Fatalf("run took %s, over the 25s budget", elapsed)
		}
		// The steady state: an unchanged re-run takes the prefetch skip path.
		e.clock.Advance(time.Hour)
		start = time.Now()
		rep = e.mustComplete(erp.ModeFull)
		t.Logf("500-FG unchanged full run took %s", time.Since(start))
		if r := e.resource(rep, erp.ResourceFinishedGoods); r.Upserted != 500 {
			t.Fatalf("unchanged rerun result = %+v", r)
		}
	})

	t.Run("reconcile-cap-refuses-a-big-gap", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		for i := 0; i < 30; i++ {
			e.fg(fmt.Sprintf("k%02d", i), fmt.Sprintf("K%02d", i), fmt.Sprintf("Kappa %02d", i), "EDP", 0, "ACTIVE", "")
		}
		e.mustComplete(erp.ModeFull)
		e.clock.Advance(time.Hour)
		for i := 0; i < 10; i++ { // 10 of 30 = 33% > 20%
			e.fg(fmt.Sprintf("k%02d", i), fmt.Sprintf("K%02d", i), fmt.Sprintf("Kappa %02d", i), "EDP", 0, "ACTIVE", `,"deleted_at":"2026-06-01T00:30:00Z"`)
		}
		rep := e.mustComplete(erp.ModeFull)
		r := e.resource(rep, erp.ResourceFinishedGoods)
		if r.Deactivated != 0 || !strings.Contains(r.Error, "reconcile refused") {
			t.Fatalf("fg result = %+v", r)
		}
		erWantInt(t, "nothing deactivated", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE is_active`), 30)
		if got := erStr(t, ctx, pool, `SELECT last_error FROM integration_watermarks WHERE resource='finished_goods'`); !strings.Contains(got, "reconcile refused") {
			t.Fatalf("watermark last_error = %q", got)
		}
		if got := erStr(t, ctx, pool, `SELECT error FROM erp_sync_runs WHERE resource='finished_goods' ORDER BY started_at DESC LIMIT 1`); !strings.Contains(got, "reconcile refused") {
			t.Fatalf("run error = %q", got)
		}
		erWant(t, "watermark still advances", erStr(t, ctx, pool, `SELECT to_char(watermark AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM integration_watermarks WHERE resource='finished_goods'`), e.clock.Now().Format(time.RFC3339))
	})

	t.Run("zero-server-time-fails-the-run", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.fg("z1", "Z1", "Zeta", "EDP", 0, "ACTIVE", "")
		e.clock.mu.Lock()
		e.clock.t = time.Time{} // the stub now reports server_time 0001-01-01
		e.clock.mu.Unlock()
		rep := e.run(erp.ModeFull)
		if rep.Status != erp.StatusFailed {
			t.Fatalf("status = %s, want failed; %+v", rep.Status, rep.Resources)
		}
		erWantInt(t, "nothing written: outlets", erCount(t, ctx, pool, `SELECT count(*) FROM outlets`), 0)
		erWantInt(t, "nothing written: products", erCount(t, ctx, pool, `SELECT count(*) FROM products`), 0)
		erWantInt(t, "no watermark committed", erCount(t, ctx, pool, `SELECT count(*) FROM integration_watermarks WHERE watermark IS NOT NULL`), 0)
	})

	t.Run("lock-released-after-failed-run", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("l1", "L1", "Lambda", "EDP", 0, "ACTIVE", "")
		e.hook("/_stub/fault?status=503&count=1", `{}`) // the first (outlets) request fails
		if rep := e.run(erp.ModeFull); rep.Status != erp.StatusFailed {
			t.Fatalf("first run = %+v", rep)
		}
		rep := e.run(erp.ModeFull)
		if rep.Status != erp.StatusCompleted {
			t.Fatalf("a run after a failed run must proceed (lock released): %+v", rep)
		}
		erWantInt(t, "variant created by the second run", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants`), 1)
	})

	t.Run("concurrent-runs-single-flight", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		e.fg("c1", "C1", "Chi One", "EDP", 0, "ACTIVE", "")
		started, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		e.tr.mu.Lock()
		e.tr.before = func(*http.Request) {
			once.Do(func() { close(started) })
			<-release
		}
		e.tr.mu.Unlock()

		first := make(chan erp.CatalogReport, 1)
		go func() {
			rep, err := e.syncer.Run(ctx, erp.ModeFull)
			if err != nil {
				t.Error(err)
			}
			first <- rep
		}()
		<-started
		second, err := e.syncer.Run(ctx, erp.ModeFull)
		if err != nil {
			t.Fatal(err)
		}
		if second.Status != erp.StatusSkippedLocked || len(second.Resources) != 0 {
			t.Fatalf("second run = %+v, want skipped_locked", second)
		}
		close(release)
		if rep := <-first; rep.Status != erp.StatusCompleted {
			t.Fatalf("first run = %+v", rep)
		}
		erWantInt(t, "variants", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants`), 1)
		erWantInt(t, "products", erCount(t, ctx, pool, `SELECT count(*) FROM products`), 1)
		erWantInt(t, "run rows (only the winner wrote)", erCount(t, ctx, pool, `SELECT count(*) FROM erp_sync_runs`), 2)
		// The lock is also released after a completed run: a third run proceeds.
		if rep := e.run(erp.ModeFull); rep.Status != erp.StatusCompleted {
			t.Fatalf("third run after completion = %+v", rep)
		}
	})

	t.Run("http-triggers", func(t *testing.T) {
		const schedulerToken = "er-scheduler-token-0123456789abcdef0123"
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.fg("h1", "H1", "Hotel One 30ml", "EDP", 30, "ACTIVE", "")

		secret := []byte("ER-HTTP-SYNTHETIC-KEY")
		issue := func(uid, role string) string {
			tk, err := auth.IssueAccess(secret, time.Hour, uid, role, "", nil)
			if err != nil {
				t.Fatal(err)
			}
			return tk
		}
		adminTok := issue("00000000-0000-4000-8f20-000000000001", "admin")
		cashierTok := issue("00000000-0000-4000-8f20-000000000002", "cashier")

		build := func(token string, runner ErpCatalogRunner) http.Handler {
			h := New(read.New(pool), nil, nil, nil, nil, nil, nil)
			h.SetErpCatalogRunner(runner)
			cfg := &config.Config{AccessSecret: secret, ERPSchedulerToken: token}
			r := chi.NewRouter()
			r.Route("/api/v1", func(r chi.Router) {
				r.With(mw.RequireSchedulerSecret(cfg)).Post("/internal/erp/catalog-pull", h.ErpCatalogPullScheduler)
				r.Group(func(r chi.Router) {
					r.Use(mw.RequireAuth(cfg), mw.RequireRole("admin"))
					r.Post("/admin/erp/catalog-pull", h.ErpCatalogPullAdmin)
					r.Get("/admin/erp/sync-runs", h.ErpSyncRuns)
				})
			})
			return r
		}
		router := build(schedulerToken, e.syncer)
		call := func(rt http.Handler, method, path string, hdr map[string]string) (int, string) {
			req := httptest.NewRequest(method, path, nil)
			for k, v := range hdr {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			rt.ServeHTTP(rec, req)
			return rec.Code, rec.Body.String()
		}
		type pullBody struct {
			Data struct {
				Status    string `json:"status"`
				Resources []struct {
					Resource string `json:"resource"`
					Mode     string `json:"mode"`
					Status   string `json:"status"`
					Upserted int    `json:"upserted"`
				} `json:"resources"`
			} `json:"data"`
		}
		const sched = "/api/v1/internal/erp/catalog-pull"
		const adm = "/api/v1/admin/erp/catalog-pull"

		// Scheduler route: secret required, nothing is written without it.
		if code, body := call(router, http.MethodPost, sched, nil); code != http.StatusUnauthorized || strings.Contains(body, schedulerToken) {
			t.Fatalf("no header = %d %s", code, body)
		}
		if code, _ := call(router, http.MethodPost, sched, map[string]string{"X-Scheduler-Secret": "wrong"}); code != http.StatusUnauthorized {
			t.Fatalf("wrong header = %d", code)
		}
		erWantInt(t, "nothing ran without the secret", erCount(t, ctx, pool, `SELECT count(*) FROM erp_sync_runs`), 0)
		good := map[string]string{"X-Scheduler-Secret": schedulerToken}
		if code, body := call(router, http.MethodPost, sched+"?mode=nope", good); code != http.StatusBadRequest {
			t.Fatalf("bad mode = %d %s", code, body)
		}
		code, body := call(router, http.MethodPost, sched, good) // default: incremental (no watermark yet, so it runs as full)
		var pb pullBody
		if err := json.Unmarshal([]byte(body), &pb); err != nil || code != http.StatusOK || pb.Data.Status != erp.StatusCompleted || len(pb.Data.Resources) != 2 {
			t.Fatalf("scheduler run = %d %s (%v)", code, body, err)
		}
		erWantInt(t, "variant pulled", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE sku='H1'`), 1)

		// Unset token disables the route; a nil runner answers 503 even with the right secret.
		if code, _ := call(build("", e.syncer), http.MethodPost, sched, good); code != http.StatusServiceUnavailable {
			t.Fatalf("unset token = %d", code)
		}
		if code, body := call(build(schedulerToken, nil), http.MethodPost, sched, good); code != http.StatusServiceUnavailable || !strings.Contains(body, "ERP integration disabled") {
			t.Fatalf("disabled integration = %d %s", code, body)
		}

		// Admin route: role gated, default mode full.
		if code, _ := call(router, http.MethodPost, adm, nil); code != http.StatusUnauthorized {
			t.Fatalf("admin no token = %d", code)
		}
		if code, _ := call(router, http.MethodPost, adm, map[string]string{"Authorization": "Bearer " + cashierTok}); code != http.StatusForbidden {
			t.Fatalf("cashier = %d", code)
		}
		code, body = call(router, http.MethodPost, adm, map[string]string{"Authorization": "Bearer " + adminTok})
		pb = pullBody{}
		if err := json.Unmarshal([]byte(body), &pb); err != nil || code != http.StatusOK || pb.Data.Status != erp.StatusCompleted ||
			len(pb.Data.Resources) != 2 || pb.Data.Resources[0].Mode != "full" {
			t.Fatalf("admin run = %d %s (%v)", code, body, err)
		}

		// sync-runs: newest first, limit honoured, watermarks included; admin only.
		if code, _ := call(router, http.MethodGet, "/api/v1/admin/erp/sync-runs", map[string]string{"Authorization": "Bearer " + cashierTok}); code != http.StatusForbidden {
			t.Fatalf("cashier sync-runs = %d", code)
		}
		type runsBody struct {
			Data struct {
				Runs       []struct{ Resource, Status string } `json:"runs"`
				Watermarks []struct{ Resource string }         `json:"watermarks"`
			} `json:"data"`
		}
		var rb runsBody
		code, body = call(router, http.MethodGet, "/api/v1/admin/erp/sync-runs", map[string]string{"Authorization": "Bearer " + adminTok})
		if err := json.Unmarshal([]byte(body), &rb); err != nil || code != http.StatusOK || len(rb.Data.Runs) != 4 || len(rb.Data.Watermarks) != 2 {
			t.Fatalf("sync-runs = %d %s (%v)", code, body, err)
		}
		rb = runsBody{}
		code, body = call(router, http.MethodGet, "/api/v1/admin/erp/sync-runs?limit=1", map[string]string{"Authorization": "Bearer " + adminTok})
		if err := json.Unmarshal([]byte(body), &rb); err != nil || code != http.StatusOK || len(rb.Data.Runs) != 1 {
			t.Fatalf("sync-runs limit=1 = %d %s (%v)", code, body, err)
		}
		if code, _ := call(router, http.MethodGet, "/api/v1/admin/erp/sync-runs?limit=0", map[string]string{"Authorization": "Bearer " + adminTok}); code != http.StatusBadRequest {
			t.Fatalf("sync-runs limit=0 = %d", code)
		}

		// Two concurrent scheduler calls: one completes, the other is skipped_locked (still 200).
		started, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		e.tr.mu.Lock()
		e.tr.before = func(*http.Request) {
			once.Do(func() { close(started) })
			<-release
		}
		e.tr.mu.Unlock()
		type result struct {
			code int
			body string
		}
		first := make(chan result, 1)
		go func() {
			c, b := call(router, http.MethodPost, sched+"?mode=full", good)
			first <- result{c, b}
		}()
		<-started
		code, body = call(router, http.MethodPost, sched+"?mode=full", good)
		pb = pullBody{}
		if err := json.Unmarshal([]byte(body), &pb); err != nil || code != http.StatusOK || pb.Data.Status != erp.StatusSkippedLocked {
			t.Fatalf("concurrent second call = %d %s (%v)", code, body, err)
		}
		close(release)
		res := <-first
		pb = pullBody{}
		if err := json.Unmarshal([]byte(res.body), &pb); err != nil || res.code != http.StatusOK || pb.Data.Status != erp.StatusCompleted {
			t.Fatalf("concurrent first call = %d %s (%v)", res.code, res.body, err)
		}
		erWantInt(t, "run rows after the concurrent pair (only the winner wrote)", erCount(t, ctx, pool, `SELECT count(*) FROM erp_sync_runs`), 6)
	})

	// A pull writes the catalog behind the Redis read cache (15 s TTL); both trigger
	// routes must drop it, so a product list read right after a pull shows the pulled rows.
	t.Run("pull-drops-read-cache", func(t *testing.T) {
		const schedulerToken = "er-scheduler-token-cache-0123456789abcdef"
		e := newErEnv(t, ctx, pool, 0)
		e.outlet("kemang", "KMG", "Mandalika Kemang", "")
		e.fg("c1", "C1", "Cedar One 30ml", "EDP", 30, "ACTIVE", "")

		secret := []byte("ER-CACHE-SYNTHETIC-KEY")
		adminTok, err := auth.IssueAccess(secret, time.Hour, "00000000-0000-4000-8f20-000000000001", "admin", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		mr := miniredis.RunT(t)
		rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = rc.Close() })
		h := New(read.New(pool), cache.NewFromClient(rc), nil, nil, nil, nil, nil)
		h.SetErpCatalogRunner(e.syncer)
		cfg := &config.Config{AccessSecret: secret, ERPSchedulerToken: schedulerToken}
		router := chi.NewRouter()
		router.Route("/api/v1", func(r chi.Router) {
			r.With(mw.RequireSchedulerSecret(cfg)).Post("/internal/erp/catalog-pull", h.ErpCatalogPullScheduler)
			r.Group(func(r chi.Router) {
				r.Use(mw.RequireAuth(cfg), mw.RequireRole("admin"))
				r.Post("/admin/erp/catalog-pull", h.ErpCatalogPullAdmin)
				r.Get("/products", h.Products)
			})
		})
		do := func(method, path string, hdr map[string]string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, path, nil)
			for k, v := range hdr {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s %s = %d %s", method, path, rec.Code, rec.Body.String())
			}
			return rec
		}
		admin := map[string]string{"Authorization": "Bearer " + adminTok}
		list := func() *httptest.ResponseRecorder { return do(http.MethodGet, "/api/v1/products", admin) }

		if rec := list(); strings.Contains(rec.Body.String(), "Cedar") || rec.Header().Get("X-Cache") != "MISS" {
			t.Fatalf("priming read = %s %s", rec.Header().Get("X-Cache"), rec.Body.String())
		}
		if rec := list(); rec.Header().Get("X-Cache") != "HIT" {
			t.Fatalf("second read must come from the cache, got %q", rec.Header().Get("X-Cache"))
		}

		do(http.MethodPost, "/api/v1/admin/erp/catalog-pull", admin)
		if rec := list(); !strings.Contains(rec.Body.String(), "Cedar One") {
			t.Fatalf("list right after the admin pull lacks the pulled product (X-Cache %s): %s", rec.Header().Get("X-Cache"), rec.Body.String())
		}

		e.fg("d1", "D1", "Driftwood Two 30ml", "EDP", 30, "ACTIVE", "")
		do(http.MethodPost, "/api/v1/internal/erp/catalog-pull?mode=full", map[string]string{"X-Scheduler-Secret": schedulerToken})
		if rec := list(); !strings.Contains(rec.Body.String(), "Driftwood Two") {
			t.Fatalf("list right after the scheduler pull lacks the pulled product (X-Cache %s): %s", rec.Header().Get("X-Cache"), rec.Body.String())
		}
	})
}
