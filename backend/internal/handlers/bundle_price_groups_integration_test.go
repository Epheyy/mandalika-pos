package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/bundles"
	"github.com/mandalika/pos-backend/internal/read"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// bundleEnv is the fixture TestBundlesPostgres hands to the price-group subtests.
type bundleEnv struct {
	pool       *pgxpool.Pool
	ctx        context.Context
	rd         *read.Repo
	wr         *write.Repo
	outlet     string
	champ      string
	do         func(tok, method, path string, body any) (int, map[string]any)
	tokFor     func(perms []string) string
	tokForRole func(role string, perms []string) string
}

// bundlePriceGroupSubtests run after bundleSaleSubtests and share one database: each leaves
// it as the migration made it (no Premium prices, every outlet in the default group).
func bundlePriceGroupSubtests(t *testing.T, e bundleEnv) {
	effectivePricesByOutletSubtest(t, e)
	settingsGetGroupsSubtest(t, e)
	settingsPutGroupsSubtests(t, e)
	priceGroupCrudSubtest(t, e)
}

func effectivePricesByOutletSubtest(t *testing.T, e bundleEnv) {
	t.Run("effective_prices_by_outlet", func(t *testing.T) {
		const (
			premiumID = "5ad7a12d-0000-4000-8000-000000000002"
			outlet2   = "00000000-0000-4000-8f00-0000000000e3"
			stranger  = "00000000-0000-4000-8f00-0000000000ff"
		)
		exec := func(q string, args ...any) {
			t.Helper()
			if _, err := e.pool.Exec(e.ctx, q, args...); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() {
			// This cleanup is what later price-group subtests rely on: report a failure loudly.
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`UPDATE outlets SET price_group_id = NULL`, nil},
				{`DELETE FROM bundle_prices WHERE group_id = $1`, []any{premiumID}},
				{`DELETE FROM outlets WHERE id = $1`, []any{outlet2}},
			} {
				if _, err := e.pool.Exec(e.ctx, q.sql, q.args...); err != nil {
					t.Errorf("cleanup %q: %v", q.sql, err)
				}
			}
		})
		exec(`INSERT INTO outlets(id,name) VALUES($1,'BN Outlet 3')`, outlet2)
		// Standar rows (default group): the same values earlier subtests saved.
		for _, r := range []struct {
			line string
			p    int
		}{{"", 795000}, {"EXTRAIT DE PARFUM", 850000}} {
			exec(`INSERT INTO bundle_prices(line,size,price) VALUES($1,'120ml',$2)
			      ON CONFLICT (group_id,line,size) DO UPDATE SET price = EXCLUDED.price`, r.line, r.p)
		}
		exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','120ml',950000)`, premiumID)
		exec(`UPDATE outlets SET price_group_id = $1 WHERE id = $2`, premiumID, e.outlet)

		price := func(outletID, line, size string) float64 {
			t.Helper()
			p, err := bundles.LoadPrices(e.ctx, e.pool, outletID)
			if err != nil {
				t.Fatal(err)
			}
			v, _ := p.PriceFor(line, size)
			return v
		}
		if got := price(e.outlet, "EXTRAIT DE PARFUM", "120ml"); got != 950000 {
			t.Errorf("Premium outlet EXT 120ml = %v, want 950000", got)
		}
		if got := price(e.outlet, "PARFUM INTENSE", "120ml"); got != 950000 {
			t.Errorf("Premium outlet PI 120ml = %v, want 950000", got)
		}
		for name, id := range map[string]string{"outlet2": outlet2, "empty": "", "NoOutlet": read.NoOutlet, "unknown": stranger, "non-uuid": "not-a-uuid"} {
			if got := price(id, "EXTRAIT DE PARFUM", "120ml"); got != 850000 {
				t.Errorf("%s: EXT 120ml = %v, want Standar 850000", name, got)
			}
		}

		pulled := func(outletID string) float64 {
			t.Helper()
			b, err := syncpkg.New(e.pool, e.rd, nil, e.wr).Pull(e.ctx, read.Scope{OutletID: outletID}, outletID)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(b)
			return champExtOffer(t, raw, e.champ)
		}
		if got := pulled(e.outlet); got != 950000 {
			t.Errorf("Premium outlet pull offer = %v, want 950000", got)
		}
		if got := pulled(outlet2); got != 850000 {
			t.Errorf("Standar outlet pull offer = %v, want 850000", got)
		}

		code, data := e.do(e.tokFor(nil), http.MethodGet, "/bundles/catalog", nil)
		if code != http.StatusOK {
			t.Fatalf("GET /bundles/catalog = %d", code)
		}
		raw, _ := json.Marshal(map[string]any{"bundleCatalog": data["data"]})
		if got := champExtOffer(t, raw, e.champ); got != 850000 {
			t.Errorf("CrossAll catalog offer = %v, want Standar 850000", got)
		}
	})
}

func settingsGetGroupsSubtest(t *testing.T, e bundleEnv) {
	t.Run("settings_get_groups", func(t *testing.T) {
		const (
			standarID = "5ad7a12d-0000-4000-8000-000000000001"
			premiumID = "5ad7a12d-0000-4000-8000-000000000002"
			reportOut = "00000000-0000-4000-8f00-0000000000e2" // 'BN Outlet 2', left by the report subtests
			outlet2   = "00000000-0000-4000-8f00-0000000000e4" // inactive, named to sort first by name
			lowerOut  = "00000000-0000-4000-8f00-0000000000e5" // active, lowercase name
		)
		exec := func(q string, args ...any) {
			t.Helper()
			if _, err := e.pool.Exec(e.ctx, q, args...); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() {
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`UPDATE outlets SET price_group_id = NULL`, nil},
				{`DELETE FROM bundle_prices WHERE group_id = $1`, []any{premiumID}},
				{`DELETE FROM outlets WHERE id = ANY($1)`, []any{[]string{outlet2, lowerOut}}},
			} {
				if _, err := e.pool.Exec(e.ctx, q.sql, q.args...); err != nil {
					t.Errorf("cleanup %q: %v", q.sql, err)
				}
			}
		})
		exec(`INSERT INTO outlets(id,name,is_active) VALUES($1,'AA Outlet',false)`, outlet2)
		exec(`INSERT INTO outlets(id,name) VALUES($1,'bn lower')`, lowerOut)
		exec(`INSERT INTO bundle_prices(line,size,price) VALUES('','120ml',795000)
		      ON CONFLICT (group_id,line,size) DO UPDATE SET price = EXCLUDED.price`)
		exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','120ml',950000)`, premiumID)
		exec(`UPDATE outlets SET price_group_id = $1 WHERE id = $2`, premiumID, e.outlet)

		code, body := e.do(e.tokFor([]string{"manage_products"}), http.MethodGet, "/settings/bundles", nil)
		if code != http.StatusOK {
			t.Fatalf("GET /settings/bundles = %d", code)
		}
		raw, _ := json.Marshal(body["data"])
		var got struct {
			Revision int64 `json:"revision"`
			Groups   []struct {
				ID          string `json:"id"`
				IsDefault   bool   `json:"isDefault"`
				OutletCount int    `json:"outletCount"`
				Standard    []struct {
					Size  string  `json:"size"`
					Price float64 `json:"price"`
				} `json:"standard"`
				LinePrices []struct{} `json:"linePrices"`
			} `json:"groups"`
			Outlets []struct {
				OutletID string `json:"outletId"`
				Code     string `json:"code"`
				IsActive bool   `json:"isActive"`
				GroupID  string `json:"groupId"`
			} `json:"outlets"`
			Standard []struct {
				Size  string  `json:"size"`
				Price float64 `json:"price"`
			} `json:"standard"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		if got.Revision < 1 {
			t.Errorf("revision = %d, want >= 1", got.Revision)
		}
		// The fixture holds four outlets: BN Outlet (moved to Premium), BN Outlet 2 (left by the report
		// subtests), the lowercase 'bn lower' and the inactive 'AA Outlet' (all no group): Premium 1, Standar 3.
		// Order: active first, then lower(name): bn lower, BN Outlet, BN Outlet 2, then AA Outlet.
		if len(got.Groups) != 2 {
			t.Fatalf("groups = %d, want 2 (%s)", len(got.Groups), raw)
		}
		std, prem := got.Groups[0], got.Groups[1]
		if std.ID != standarID || !std.IsDefault || std.OutletCount != 3 ||
			len(std.Standard) != 1 || std.Standard[0].Size != "120ml" || std.Standard[0].Price != 795000 {
			t.Errorf("groups[0] = %+v, want Standar default, 3 outlets, [120ml 795000]", std)
		}
		if prem.ID != premiumID || prem.IsDefault || prem.OutletCount != 1 ||
			len(prem.Standard) != 1 || prem.Standard[0].Size != "120ml" || prem.Standard[0].Price != 950000 {
			t.Errorf("groups[1] = %+v, want Premium, 1 outlet, [120ml 950000]", prem)
		}
		if prem.LinePrices == nil || len(prem.LinePrices) != 0 {
			t.Errorf("Premium linePrices = %v, want empty array", prem.LinePrices)
		}
		if len(got.Outlets) != 4 {
			t.Fatalf("outlets = %d, want 4 (%s)", len(got.Outlets), raw)
		}
		oLow, o1, o1b, o2 := got.Outlets[0], got.Outlets[1], got.Outlets[2], got.Outlets[3]
		if oLow.OutletID != lowerOut || !oLow.IsActive || oLow.GroupID != standarID {
			t.Errorf("outlets[0] = %+v, want the active lowercase 'bn lower' first (lower(name) order)", oLow)
		}
		if o1b.OutletID != reportOut || !o1b.IsActive || o1b.GroupID != standarID {
			t.Errorf("outlets[2] = %+v, want the active no-group BN Outlet 2 in Standar", o1b)
		}
		if o1.OutletID != e.outlet || !o1.IsActive || o1.GroupID != premiumID || o1.Code != "" {
			t.Errorf("outlets[1] = %+v, want the active Premium outlet with empty code", o1)
		}
		if o2.OutletID != outlet2 || o2.IsActive || o2.GroupID != standarID || o2.Code != "" {
			t.Errorf("outlets[3] = %+v, want inactive (last despite sorting first by name) outlet in Standar (stored NULL)", o2)
		}
		if len(got.Standard) != 1 || got.Standard[0].Size != "120ml" || got.Standard[0].Price != 795000 {
			t.Errorf("top-level standard = %+v, want only [120ml 795000]", got.Standard)
		}
	})
}

// champExtOffer finds CHAMPION's EXT 120ml offer price in a marshalled pull/catalog body.
func champExtOffer(t *testing.T, raw []byte, champ string) float64 {
	t.Helper()
	var got struct {
		BundleCatalog struct {
			Products []struct {
				ProductID string `json:"productId"`
				Offers    []struct {
					LineShort string  `json:"lineShort"`
					Size      string  `json:"size"`
					Price     float64 `json:"price"`
				} `json:"offers"`
			} `json:"products"`
		} `json:"bundleCatalog"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, p := range got.BundleCatalog.Products {
		if p.ProductID != champ {
			continue
		}
		for _, o := range p.Offers {
			if o.LineShort == "EXT" && o.Size == "120ml" {
				return o.Price
			}
		}
	}
	t.Fatalf("CHAMPION EXT 120ml offer missing in %s", raw)
	return 0
}

// bundlePriceGroupMigrationSubtest pins the schema of migration 0105. It leaves the database
// exactly as the migration made it: later price-group subtests share it.
func bundlePriceGroupMigrationSubtest(t *testing.T, pool *pgxpool.Pool, ctx context.Context) {
	t.Run("price_groups_migration", func(t *testing.T) {
		const (
			standarID = "5ad7a12d-0000-4000-8000-000000000001"
			premiumID = "5ad7a12d-0000-4000-8000-000000000002"
		)
		rows, err := pool.Query(ctx, `SELECT id::text, name, is_default, sort_order FROM price_groups ORDER BY sort_order`)
		if err != nil {
			t.Fatal(err)
		}
		type grp struct {
			id, name string
			def      bool
			sort     int
		}
		var got []grp
		for rows.Next() {
			var g grp
			if err := rows.Scan(&g.id, &g.name, &g.def, &g.sort); err != nil {
				t.Fatal(err)
			}
			got = append(got, g)
		}
		rows.Close()
		want := []grp{{standarID, "Standar", true, 0}, {premiumID, "Premium", false, 1}}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("price_groups = %v, want %v", got, want)
		}

		var defID, colDef string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM price_groups WHERE is_default`).Scan(&defID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns
			WHERE table_name='bundle_prices' AND column_name='group_id'`).Scan(&colDef); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(colDef, defID) {
			t.Fatalf("bundle_prices.group_id default = %q, want it to contain %s", colDef, defID)
		}

		var nullable string
		var outletDef *string
		if err := pool.QueryRow(ctx, `SELECT is_nullable, column_default FROM information_schema.columns
			WHERE table_name='outlets' AND column_name='price_group_id'`).Scan(&nullable, &outletDef); err != nil {
			t.Fatal(err)
		}
		if nullable != "YES" || outletDef != nil {
			t.Fatalf("outlets.price_group_id nullable=%s default=%v, want YES and NULL", nullable, outletDef)
		}

		var pk []string
		prow, err := pool.Query(ctx, `SELECT a.attname FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = 'bundle_prices'::regclass AND i.indisprimary
			ORDER BY array_position(i.indkey::int2[], a.attnum)`)
		if err != nil {
			t.Fatal(err)
		}
		for prow.Next() {
			var c string
			if err := prow.Scan(&c); err != nil {
				t.Fatal(err)
			}
			pk = append(pk, c)
		}
		prow.Close()
		if strings.Join(pk, ",") != "group_id,line,size" {
			t.Fatalf("bundle_prices PK = %v, want group_id,line,size", pk)
		}

		// Rollback safety: an insert that ignores group_id (the pre-groups write path) lands in the default group.
		var gid string
		if err := pool.QueryRow(ctx, `INSERT INTO bundle_prices(line,size,price,updated_by) VALUES('','130ml',1,NULL)
			RETURNING group_id::text`).Scan(&gid); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM bundle_prices WHERE line='' AND size='130ml'`); err != nil {
			t.Fatal(err)
		}
		if gid != defID {
			t.Fatalf("group_id-less insert landed in %s, want default %s", gid, defID)
		}

		expect23505 := func(name, q string, args ...any) {
			t.Helper()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, q, args...)
			var pe *pgconn.PgError
			if !errors.As(err, &pe) || pe.Code != "23505" {
				t.Fatalf("%s: err = %v, want 23505", name, err)
			}
		}
		expect23505("second default", `INSERT INTO price_groups(name,is_default,sort_order) VALUES('Lain',true,5)`)
		expect23505("case-insensitive name", `INSERT INTO price_groups(name,sort_order) VALUES('standar',5)`)

		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','130ml',1)`, premiumID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM price_groups WHERE id=$1`, premiumID); err != nil {
			t.Fatal(err)
		}
		var left int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM bundle_prices WHERE group_id=$1`, premiumID).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("deleting Premium left %d bundle_prices rows, want cascade", left)
		}

		var rev int64
		if err := pool.QueryRow(ctx, `SELECT revision FROM bundle_price_revision`).Scan(&rev); err != nil {
			t.Fatal(err)
		}
		if rev != 1 {
			t.Fatalf("bundle_price_revision = %d, want 1", rev)
		}
	})
}
