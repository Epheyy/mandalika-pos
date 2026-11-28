package handlers

import (
	"net/http"
	"strings"
	"testing"
)

// priceGroupCrudSubtest covers POST/PUT/DELETE /price-groups. Its cleanup leaves exactly Standar
// and Premium as the migration made them (later subtests rely on it).
func priceGroupCrudSubtest(t *testing.T, e bundleEnv) {
	t.Run("price_group_crud", func(t *testing.T) {
		const premiumName = "Premium"
		t.Cleanup(func() {
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`UPDATE outlets SET price_group_id = NULL`, nil},
				{`DELETE FROM price_groups WHERE id NOT IN ($1, $2)`, []any{putStandarID, putPremiumID}},
				{`DELETE FROM bundle_prices WHERE group_id = $1`, []any{putPremiumID}},
				{`UPDATE price_groups SET name = $2 WHERE id = $1`, []any{putPremiumID, premiumName}},
			} {
				if _, err := e.pool.Exec(e.ctx, q.sql, q.args...); err != nil {
					t.Errorf("cleanup %q: %v", q.sql, err)
				}
			}
		})
		k := newBundlePutKit(t, e)
		admin := e.tokFor(nil)

		revision := k.revision()
		versions := func() string {
			var s string
			if err := e.pool.QueryRow(e.ctx, `SELECT COALESCE(string_agg(outlet_id::text||':'||version||':'||data_manifest::text, ',' ORDER BY outlet_id), '')
				FROM content_versions`).Scan(&s); err != nil {
				t.Fatal(err)
			}
			return s
		}
		versionsBefore := versions()
		call := func(method, path string, body any) (int, map[string]any) {
			t.Helper()
			return e.do(admin, method, path, body)
		}
		wantErr := func(code int, body map[string]any, wantCode int, msg string) {
			t.Helper()
			if code != wantCode || body["error"] != msg {
				t.Fatalf("got %d %v, want %d %q", code, body, wantCode, msg)
			}
		}
		create := func(name string) (int, map[string]any) {
			return call(http.MethodPost, "/price-groups", map[string]any{"name": name})
		}

		code, body := create("Mall")
		if code != http.StatusCreated {
			t.Fatalf("POST Mall = %d %v", code, body)
		}
		mallID, _ := body["data"].(map[string]any)["id"].(string)
		if mallID == "" {
			t.Fatalf("POST Mall returned no id: %v", body)
		}
		code, body = create(" mall ")
		wantErr(code, body, http.StatusConflict, "Nama kelompok sudah dipakai")
		code, body = create("   ")
		wantErr(code, body, http.StatusBadRequest, "Nama kelompok wajib diisi")
		code, body = create(strings.Repeat("a", 41))
		wantErr(code, body, http.StatusBadRequest, "Nama kelompok maksimal 40 karakter")
		// Standar, Premium, Mall + two more = 5; the 6th is refused.
		var spareID string
		for _, n := range []string{"G4", "G5"} {
			code, body = create(n)
			if code != http.StatusCreated {
				t.Fatalf("POST %s = %d %v", n, code, body)
			}
			spareID, _ = body["data"].(map[string]any)["id"].(string)
		}
		code, body = create("G6")
		wantErr(code, body, http.StatusConflict, "Maksimal 5 kelompok harga")
		var maxSort, n int
		if err := e.pool.QueryRow(e.ctx, `SELECT max(sort_order), count(*) FROM price_groups`).Scan(&maxSort, &n); err != nil || maxSort != 4 || n != 5 {
			t.Errorf("sort_order max/count = %d/%d (%v), want 4/5", maxSort, n, err)
		}

		code, body = call(http.MethodPut, "/price-groups/"+putPremiumID, map[string]any{"name": "Premium Mall"})
		if code != http.StatusOK {
			t.Fatalf("PUT rename = %d %v", code, body)
		}
		code, got := call(http.MethodGet, "/settings/bundles", nil)
		if code != http.StatusOK {
			t.Fatalf("GET = %d %v", code, got)
		}
		renamed := false
		for _, g := range got["data"].(map[string]any)["groups"].([]any) {
			if m := g.(map[string]any); m["id"] == putPremiumID && m["name"] == "Premium Mall" {
				renamed = true
			}
		}
		if !renamed {
			t.Errorf("GET /settings/bundles does not show Premium Mall: %v", got["data"])
		}
		code, body = call(http.MethodPut, "/price-groups/"+putStandarID, map[string]any{"name": "STANDAR"})
		if code != http.StatusOK { // renaming a group to its own name (any case) is fine
			t.Fatalf("PUT Standar -> STANDAR = %d %v", code, body)
		}
		code, body = call(http.MethodPut, "/price-groups/"+putStandarID, map[string]any{"name": "Standar"})
		if code != http.StatusOK {
			t.Fatalf("PUT STANDAR -> Standar = %d %v", code, body)
		}
		code, body = call(http.MethodPut, "/price-groups/"+putPremiumID, map[string]any{"name": "STANDAR"})
		wantErr(code, body, http.StatusConflict, "Nama kelompok sudah dipakai")
		code, body = call(http.MethodPut, "/price-groups/00000000-0000-4000-8f00-0000000000f1", map[string]any{"name": "Nope"})
		wantErr(code, body, http.StatusNotFound, "not found")

		code, body = call(http.MethodDelete, "/price-groups/"+putStandarID, nil)
		wantErr(code, body, http.StatusConflict, "Kelompok default tidak bisa dihapus")
		k.exec(`UPDATE outlets SET price_group_id = $1 WHERE id = $2`, putPremiumID, e.outlet)
		code, body = call(http.MethodDelete, "/price-groups/"+putPremiumID, nil)
		wantErr(code, body, http.StatusConflict, "Kelompok Premium Mall masih dipakai 1 outlet. Pindahkan outletnya dulu.")
		code, body = call(http.MethodDelete, "/price-groups/00000000-0000-4000-8f00-0000000000f1", nil)
		wantErr(code, body, http.StatusNotFound, "not found")

		k.exec(`INSERT INTO bundle_prices(group_id,line,size,price) VALUES($1,'','120ml',900000)`, spareID)
		code, body = call(http.MethodDelete, "/price-groups/"+spareID, nil)
		if code != http.StatusOK {
			t.Fatalf("DELETE empty group = %d %v", code, body)
		}
		var rows, groups int
		if err := e.pool.QueryRow(e.ctx, `SELECT (SELECT count(*) FROM bundle_prices WHERE group_id = $1),
			(SELECT count(*) FROM price_groups WHERE id = $1)`, spareID).Scan(&rows, &groups); err != nil || rows != 0 || groups != 0 {
			t.Errorf("after delete: price rows %d, group rows %d (%v), want 0/0", rows, groups, err)
		}

		if got := k.revision(); got != revision {
			t.Errorf("revision = %d, want %d (group writes must not advance it)", got, revision)
		}
		if got := versions(); got != versionsBefore {
			t.Errorf("content_versions changed:\n before %s\n after  %s", versionsBefore, got)
		}
		if code, _ := e.do(e.tokForRole("cashier", nil), http.MethodPost, "/price-groups", map[string]any{"name": "X"}); code != http.StatusForbidden {
			t.Errorf("cashier POST /price-groups = %d, want 403", code)
		}
	})
}
