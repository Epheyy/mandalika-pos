package handlers

import (
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
)

const (
	putStandarID = "5ad7a12d-0000-4000-8000-000000000001"
	putPremiumID = "5ad7a12d-0000-4000-8000-000000000002"
	putOutlet2   = "00000000-0000-4000-8f00-0000000000e6"
)

// bundlePutKit is the shared fixture of the PUT /settings/bundles subtests. Its cleanup restores
// what later price-group subtests rely on: Standar rows as found, no Premium rows, every outlet
// in the default group (revision and content versions may stay advanced).
type bundlePutKit struct {
	t   *testing.T
	e   bundleEnv
	tok string
}

func newBundlePutKit(t *testing.T, e bundleEnv) *bundlePutKit {
	k := &bundlePutKit{t: t, e: e, tok: e.tokFor([]string{"manage_products"})}
	type row struct {
		line, size string
		price      float64
	}
	var saved []row
	rows, err := e.pool.Query(e.ctx, `SELECT line, size, price::float8 FROM bundle_prices WHERE group_id = $1`, putStandarID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.line, &r.size, &r.price); err != nil {
			t.Fatal(err)
		}
		saved = append(saved, r)
	}
	rows.Close()
	t.Cleanup(func() {
		fail := func(what string, err error) {
			if err != nil {
				t.Errorf("cleanup %s: %v", what, err)
			}
		}
		_, err := e.pool.Exec(e.ctx, `UPDATE outlets SET price_group_id = NULL`)
		fail("outlets", err)
		_, err = e.pool.Exec(e.ctx, `DELETE FROM bundle_prices`)
		fail("bundle_prices", err)
		for _, r := range saved {
			_, err = e.pool.Exec(e.ctx, `INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,$2,$3,$4)`,
				putStandarID, r.line, r.size, r.price)
			fail("restore Standar", err)
		}
		_, err = e.pool.Exec(e.ctx, `DELETE FROM content_versions WHERE outlet_id = $1`, putOutlet2)
		fail("content_versions", err)
		_, err = e.pool.Exec(e.ctx, `DELETE FROM outlets WHERE id = $1`, putOutlet2)
		fail("outlet2", err)
	})
	k.exec(`INSERT INTO outlets(id,name) VALUES($1,'BN Outlet PUT')`, putOutlet2)
	for _, o := range []string{e.outlet, putOutlet2} {
		k.exec(`INSERT INTO content_versions(outlet_id,version,data_manifest,updated_at) VALUES($1,5,'{}',now())
		        ON CONFLICT (outlet_id) DO NOTHING`, o)
	}
	return k
}

func (k *bundlePutKit) exec(q string, args ...any) {
	k.t.Helper()
	if _, err := k.e.pool.Exec(k.e.ctx, q, args...); err != nil {
		k.t.Fatal(err)
	}
}

// seed sets Standar to 120ml = std and Premium to 120ml = prem (0 = no Premium row).
func (k *bundlePutKit) seed(std, prem int) {
	k.t.Helper()
	k.exec(`DELETE FROM bundle_prices`)
	k.exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','120ml',$2)`, putStandarID, std)
	if prem > 0 {
		k.exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','120ml',$2)`, putPremiumID, prem)
	}
}

func (k *bundlePutKit) revision() int64 {
	k.t.Helper()
	var v int64
	if err := k.e.pool.QueryRow(k.e.ctx, `SELECT revision FROM bundle_price_revision`).Scan(&v); err != nil {
		k.t.Fatal(err)
	}
	return v
}

func (k *bundlePutKit) price(group, line string) float64 {
	k.t.Helper()
	var v float64
	err := k.e.pool.QueryRow(k.e.ctx, `SELECT price::float8 FROM bundle_prices WHERE group_id=$1 AND line=$2 AND size='120ml'`,
		group, line).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0
	}
	if err != nil {
		k.t.Fatal(err)
	}
	return v
}

func (k *bundlePutKit) group(outlet string) string {
	k.t.Helper()
	var g *string
	if err := k.e.pool.QueryRow(k.e.ctx, `SELECT price_group_id::text FROM outlets WHERE id=$1`, outlet).Scan(&g); err != nil {
		k.t.Fatal(err)
	}
	if g == nil {
		return "NULL"
	}
	return *g
}

// versions returns an outlet's content version and its bundle_prices manifest counter.
func (k *bundlePutKit) versions(outlet string) (int, int) {
	k.t.Helper()
	var v, m int
	if err := k.e.pool.QueryRow(k.e.ctx, `SELECT version, COALESCE((data_manifest->>'bundle_prices')::int,0)
		FROM content_versions WHERE outlet_id=$1`, outlet).Scan(&v, &m); err != nil {
		k.t.Fatal(err)
	}
	return v, m
}

func (k *bundlePutKit) put(body map[string]any) (int, map[string]any) {
	k.t.Helper()
	return k.e.do(k.tok, http.MethodPut, "/settings/bundles", body)
}

func (k *bundlePutKit) wantOK(code int, body map[string]any, wantRev int64) {
	k.t.Helper()
	if code != http.StatusOK {
		k.t.Fatalf("PUT = %d %v, want 200", code, body)
	}
	data, _ := body["data"].(map[string]any)
	if got, _ := data["revision"].(float64); int64(got) != wantRev {
		k.t.Errorf("PUT revision = %v, want %d", data["revision"], wantRev)
	}
}

func (k *bundlePutKit) wantErr(code int, body map[string]any, wantCode int, msg string) {
	k.t.Helper()
	if code != wantCode || body["error"] != msg {
		k.t.Fatalf("PUT = %d %v, want %d %q", code, body, wantCode, msg)
	}
}

func putStd(price int) []map[string]any {
	return []map[string]any{{"size": "120ml", "price": price}}
}

func putGroups(premiumPrice int) []map[string]any {
	return []map[string]any{{"groupId": putPremiumID, "standard": putStd(premiumPrice), "linePrices": []map[string]any{}}}
}

func settingsPutGroupsSubtests(t *testing.T, e bundleEnv) {
	t.Run("old_body_keeps_premium", func(t *testing.T) {
		k := newBundlePutKit(t, e)
		k.seed(795000, 950000)
		k.exec(`UPDATE outlets SET price_group_id = $1 WHERE id = $2`, putPremiumID, e.outlet)
		rev := k.revision()
		code, body := k.put(map[string]any{"standard": putStd(800000), "linePrices": []map[string]any{}})
		k.wantOK(code, body, rev+1)
		if got := k.price(putPremiumID, ""); got != 950000 {
			t.Errorf("Premium 120ml = %v, want 950000 (an old body must not touch other groups)", got)
		}
		if got := k.group(e.outlet); got != putPremiumID {
			t.Errorf("outlet group = %s, want it still in Premium", got)
		}
		if got := k.price(putStandarID, ""); got != 800000 {
			t.Errorf("Standar 120ml = %v, want 800000", got)
		}
		if got := k.revision(); got != rev+1 {
			t.Errorf("revision = %d, want %d", got, rev+1)
		}
	})

	t.Run("revision_cas", func(t *testing.T) {
		k := newBundlePutKit(t, e)
		k.seed(795000, 0)
		code, got := e.do(k.tok, http.MethodGet, "/settings/bundles", nil)
		if code != http.StatusOK {
			t.Fatalf("GET = %d %v", code, got)
		}
		r := int64(got["data"].(map[string]any)["revision"].(float64))
		newBody := func(price int, rev any) map[string]any {
			b := map[string]any{"standard": putStd(price), "linePrices": []map[string]any{},
				"groups": []map[string]any{}, "outletGroups": []map[string]any{}}
			if rev != nil {
				b["revision"] = rev
			}
			return b
		}
		code, body := k.put(newBody(800000, r))
		k.wantOK(code, body, r+1)
		// Same revision again (a second tab): refused, and nothing changes.
		code, body = k.put(newBody(820000, r))
		k.wantErr(code, body, http.StatusConflict, "Harga bundle sudah diubah orang lain. Muat ulang.")
		if p, rv := k.price(putStandarID, ""), k.revision(); p != 800000 || rv != r+1 {
			t.Errorf("after the 409: Standar = %v revision = %d, want 800000 and %d", p, rv, r+1)
		}
		code, body = k.put(newBody(810000, r+1))
		k.wantOK(code, body, r+2)
		code, body = k.put(newBody(810000, nil))
		k.wantErr(code, body, http.StatusBadRequest, "Revisi harga bundle wajib dikirim. Muat ulang.")
		if rv := k.revision(); rv != r+2 {
			t.Errorf("revision after the 400 = %d, want %d", rv, r+2)
		}
	})

	t.Run("cross_group_merged_state", func(t *testing.T) {
		k := newBundlePutKit(t, e)
		reseed := func() {
			k.exec(`DELETE FROM bundle_prices`)
			for _, g := range []string{putStandarID, putPremiumID} {
				k.exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','100ml',650000),($1,'','120ml',795000)`, g)
			}
		}
		reseed()
		rev := k.revision()
		code, body := k.put(map[string]any{"standard": putStd(795000), "linePrices": []map[string]any{},
			"groups": putGroups(795000), "outletGroups": []map[string]any{}, "revision": rev})
		k.wantOK(code, body, rev+1)
		var n int
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM bundle_prices WHERE size='100ml'`).Scan(&n); err != nil || n != 0 {
			t.Errorf("100ml rows after dropping it from both groups = %d (%v), want 0", n, err)
		}
		reseed()
		rev = k.revision()
		code, body = k.put(map[string]any{"standard": putStd(795000), "linePrices": []map[string]any{}})
		k.wantErr(code, body, http.StatusBadRequest, "Ukuran 100ml masih punya harga di kelompok Premium. Hapus harga itu dulu.")
		if rv := k.revision(); rv != rev {
			t.Errorf("revision after the refusal = %d, want %d (rolled back)", rv, rev)
		}
		if got := k.price(putStandarID, ""); got != 795000 {
			t.Errorf("Standar 120ml = %v after refusal", got)
		}
		var std100 int
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM bundle_prices WHERE group_id=$1 AND size='100ml'`, putStandarID).Scan(&std100); err != nil || std100 != 1 {
			t.Errorf("Standar 100ml rows after the refusal = %d (%v), want 1", std100, err)
		}
	})

	t.Run("assign_bumps_moved_only", func(t *testing.T) {
		k := newBundlePutKit(t, e)
		k.seed(800000, 950000)
		save := func(std, prem int, assign []map[string]any) {
			t.Helper()
			rev := k.revision()
			code, body := k.put(map[string]any{"standard": putStd(std), "linePrices": []map[string]any{},
				"groups": putGroups(prem), "outletGroups": assign, "revision": rev})
			k.wantOK(code, body, rev+1)
		}
		v1, m1 := k.versions(e.outlet)
		v2, m2 := k.versions(putOutlet2)
		// Assignment-only: outlet -> Premium, outlet2 -> Standar (already NULL, so not a move).
		save(800000, 950000, []map[string]any{
			{"outletId": e.outlet, "groupId": putPremiumID}, {"outletId": putOutlet2, "groupId": putStandarID}})
		if v, m := k.versions(e.outlet); v != v1+1 || m != m1+1 {
			t.Errorf("moved outlet version/manifest = %d/%d, want %d/%d", v, m, v1+1, m1+1)
		}
		if v, m := k.versions(putOutlet2); v != v2 || m != m2 {
			t.Errorf("unmoved outlet version/manifest = %d/%d, want unchanged %d/%d", v, m, v2, m2)
		}
		if g := k.group(e.outlet); g != putPremiumID {
			t.Errorf("outlet group = %s, want Premium", g)
		}
		if g := k.group(putOutlet2); g != "NULL" {
			t.Errorf("outlet2 group = %s, want NULL", g)
		}
		// Back to Standar stores NULL and bumps the moved outlet only.
		v1, m1 = k.versions(e.outlet)
		save(800000, 950000, []map[string]any{{"outletId": e.outlet, "groupId": putStandarID}})
		if g := k.group(e.outlet); g != "NULL" {
			t.Errorf("outlet group after moving back = %s, want NULL", g)
		}
		if v, m := k.versions(e.outlet); v != v1+1 || m != m1+1 {
			t.Errorf("moved-back outlet version/manifest = %d/%d, want %d/%d", v, m, v1+1, m1+1)
		}
		if v, m := k.versions(putOutlet2); v != v2 || m != m2 {
			t.Errorf("unmoved outlet version/manifest = %d/%d, want unchanged %d/%d", v, m, v2, m2)
		}
		// A price change bumps every outlet.
		v1, m1 = k.versions(e.outlet)
		save(810000, 950000, []map[string]any{})
		if v, m := k.versions(e.outlet); v != v1+1 || m != m1+1 {
			t.Errorf("outlet after a price change = %d/%d, want %d/%d", v, m, v1+1, m1+1)
		}
		if v, m := k.versions(putOutlet2); v != v2+1 || m != m2+1 {
			t.Errorf("outlet2 after a price change = %d/%d, want %d/%d", v, m, v2+1, m2+1)
		}
	})

	t.Run("group_put_rejections", func(t *testing.T) {
		k := newBundlePutKit(t, e)
		k.seed(800000, 0)
		rev := k.revision()
		save := func(extra map[string]any) (int, map[string]any) {
			t.Helper()
			b := map[string]any{"standard": putStd(800000), "linePrices": []map[string]any{},
				"groups": []map[string]any{}, "outletGroups": []map[string]any{}, "revision": rev}
			for key, v := range extra {
				b[key] = v
			}
			return k.put(b)
		}
		const unknown = "00000000-0000-4000-8f00-0000000000f0"
		code, body := save(map[string]any{"groups": []map[string]any{
			{"groupId": putStandarID, "standard": putStd(800000), "linePrices": []map[string]any{}}}})
		k.wantErr(code, body, http.StatusBadRequest, "Harga kelompok default dikirim lewat standard dan linePrices.")
		code, body = save(map[string]any{"groups": []map[string]any{
			{"groupId": unknown, "standard": putStd(800000), "linePrices": []map[string]any{}}}})
		k.wantErr(code, body, http.StatusBadRequest, "Kelompok harga tidak ditemukan. Muat ulang.")
		code, body = save(map[string]any{"outletGroups": []map[string]any{{"outletId": unknown, "groupId": putPremiumID}}})
		k.wantErr(code, body, http.StatusBadRequest, "Outlet tidak ditemukan. Muat ulang.")
		code, body = save(map[string]any{"groups": []map[string]any{{"groupId": putPremiumID, "standard": []map[string]any{},
			"linePrices": []map[string]any{{"line": "EXTRAIT DE PARFUM", "size": "120ml", "price": 1000}}}}})
		k.wantErr(code, body, http.StatusBadRequest, "Harga lini Premium 120ml butuh harga standar Premium 120ml")
		if rv := k.revision(); rv != rev {
			t.Errorf("revision after four refusals = %d, want %d (each rolled back)", rv, rev)
		}
	})
}
