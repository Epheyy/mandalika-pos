package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Bundles phase 1: bundle price settings, the derived catalog and the sync pull field.
// Driven through the real handlers; opt-in fresh synthetic cluster (port 26481, prefix BN).
// Later bundle phases add subtests here.
func TestBundlesPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "BN", 26481)
	const (
		outlet  = "00000000-0000-4000-8f00-000000000001"
		adminU  = "00000000-0000-4000-8f00-000000000011"
		champ   = "00000000-0000-4000-8f00-0000000000c1"
		no1     = "00000000-0000-4000-8f00-0000000000c2"
		secret  = "BN-SYNTHETIC-TEST-KEY"
		extCat  = "EXT"
		piCat   = "PERFUME INTENSE"
		atomCat = "ATOMIZER"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'BN Outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'bn-admin@example.invalid','x','BN Admin','admin',NULL)`, adminU)
	exec(`INSERT INTO products(id,name) VALUES($1,'CHAMPION'),($2,'NO1')`, champ, no1)
	n := 0
	variant := func(pid, size, cat string, price int) {
		n++
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug,erp_category)
		      VALUES($1,$2,$3,0,$4,$5,$6)`, pid, size, price, "BNSKU"+string(rune('A'+n)), "bn-slug-"+string(rune('a'+n)), cat)
	}
	variant(champ, "120ml EXTRAIT DE PARFUM", extCat, 1200000)
	variant(champ, "120ml PARFUM INTENSE", piCat, 1100000)
	variant(champ, "10ml ATOMIZER", atomCat, 250000)
	variant(champ, "2ml EXTRAIT DE PARFUM", extCat, 60000)
	variant(champ, "2ml PARFUM INTENSE", piCat, 55000)
	variant(no1, "120ml EXTRAIT DE PARFUM", extCat, 1200000)
	variant(no1, "2ml EXTRAIT DE PARFUM", extCat, 60000)

	rd, wr := read.New(pool), write.New(pool)
	h := New(rd, nil, nil, wr, nil, nil, nil)
	key := []byte(secret)
	tokForRole := func(role string, perms []string) string {
		tok, err := auth.IssueAccess(key, time.Hour, adminU, role, "", perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokFor := func(perms []string) string { return tokForRole("admin", perms) }
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: key}))
	router.Get("/settings/bundles", h.GetBundleSettings)
	router.Get("/bundles/catalog", h.GetBundleCatalog)
	router.Group(func(r chi.Router) {
		r.Use(mw.RequirePermission("manage_products"))
		r.Put("/settings/bundles", h.UpdateBundleSettings)
	})
	do := func(tok, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&buf).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Authorization", "Bearer "+tok)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	valid := map[string]any{
		"standard": []map[string]any{
			{"size": "100ml", "price": 650000}, {"size": "110ml", "price": 725000}, {"size": "120ml", "price": 795000}},
		"linePrices": []map[string]any{{"line": "EXTRAIT DE PARFUM", "size": "120ml", "price": 850000}},
	}
	version := func() int64 {
		var v int64
		if err := pool.QueryRow(ctx, `SELECT COALESCE(max(version),0) FROM content_versions`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	t.Run("settings_forbidden", func(t *testing.T) {
		if code, _ := do(tokForRole("cashier", nil), http.MethodPut, "/settings/bundles", valid); code != http.StatusForbidden {
			t.Fatalf("PUT without manage_products = %d, want 403", code)
		}
	})

	t.Run("version_bumps", func(t *testing.T) {
		before := version()
		if code, body := do(tokFor([]string{"manage_products"}), http.MethodPut, "/settings/bundles", valid); code != http.StatusOK {
			t.Fatalf("PUT = %d %v", code, body)
		}
		if after := version(); after <= before {
			t.Fatalf("content version %d did not increase from %d", after, before)
		}
	})

	t.Run("settings_roundtrip", func(t *testing.T) {
		tok := tokFor([]string{"manage_products"})
		code, body := do(tok, http.MethodGet, "/settings/bundles", nil)
		if code != http.StatusOK {
			t.Fatalf("GET = %d %v", code, body)
		}
		data := body["data"].(map[string]any)
		if std := data["standard"].([]any); len(std) != 3 || std[2].(map[string]any)["price"].(float64) != 795000 {
			t.Fatalf("standard = %v", std)
		}
		lp := data["linePrices"].([]any)
		if len(lp) != 1 || lp[0].(map[string]any)["line"] != "EXTRAIT DE PARFUM" || lp[0].(map[string]any)["price"].(float64) != 850000 {
			t.Fatalf("linePrices = %v", lp)
		}
		lines := data["lines"].([]any)
		found := 0
		for _, l := range lines {
			m := l.(map[string]any)
			if m["line"] == "EXTRAIT DE PARFUM" && m["label"] == "Extrait" && m["short"] == "EXT" {
				found++
			}
		}
		if found != 1 {
			t.Fatalf("lines = %v, want Extrait once", lines)
		}
	})

	t.Run("settings_invalid_is_400_with_copy", func(t *testing.T) {
		bad := map[string]any{"standard": []map[string]any{{"size": "120", "price": 1000}}, "linePrices": []map[string]any{}}
		code, body := do(tokFor([]string{"manage_products"}), http.MethodPut, "/settings/bundles", bad)
		if code != http.StatusBadRequest {
			t.Fatalf("PUT = %d %v, want 400", code, body)
		}
		if body["error"] != "Ukuran harus seperti 120ml" {
			t.Fatalf("error = %v", body)
		}
	})

	t.Run("pull_has_catalog", func(t *testing.T) {
		b, err := syncpkg.New(pool, rd, nil, wr).Pull(ctx, read.Scope{OutletID: outlet}, outlet)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(b)
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
				Pieces []struct {
					ProductID string `json:"productId"`
				} `json:"pieces"`
			} `json:"bundleCatalog"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		for _, p := range got.BundleCatalog.Products {
			if p.ProductID != champ {
				continue
			}
			if len(p.Offers) != 2 || p.Offers[0].LineShort != "EXT" || p.Offers[0].Price != 850000 ||
				p.Offers[1].LineShort != "PI" || p.Offers[1].Price != 795000 {
				t.Fatalf("CHAMPION offers = %+v", p.Offers)
			}
			pieces := 0
			for _, pc := range got.BundleCatalog.Pieces {
				if pc.ProductID == champ {
					pieces++
				}
			}
			if pieces != 5 {
				t.Fatalf("CHAMPION pieces = %d, want 5", pieces)
			}
			return
		}
		t.Fatalf("CHAMPION not in the pulled bundle catalog: %s", raw)
	})

	t.Run("catalog_backoffice", func(t *testing.T) {
		code, body := do(tokFor([]string{"manage_products"}), http.MethodGet, "/bundles/catalog", nil)
		if code != http.StatusOK {
			t.Fatalf("GET = %d %v", code, body)
		}
		for _, p := range body["data"].(map[string]any)["products"].([]any) {
			m := p.(map[string]any)
			if m["productId"] != no1 {
				continue
			}
			missing := m["missing"].([]any)
			if len(m["offers"].([]any)) != 0 || len(missing) != 1 ||
				missing[0].(map[string]any)["text"] != "atomizer belum ada" {
				t.Fatalf("NO1 = %v", m)
			}
			return
		}
		t.Fatal("NO1 not in the backoffice catalog")
	})
}
