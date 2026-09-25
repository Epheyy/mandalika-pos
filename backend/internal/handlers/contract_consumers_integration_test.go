package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/uploads"
	"github.com/mandalika/pos-backend/internal/write"
)

// Called ONLY after TestPaginationPostgres's unchanged exact-target, directory,
// empty-schema and migration guards. All records belong to that disposable DB.
func qualifyContractConsumers(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	const source = "00000000-0000-4000-8700-000000000001"
	const dest = "00000000-0000-4000-8700-000000000002"
	const transfer = "00000000-0000-4000-8700-000000000003"
	const ingredient = "00000000-0000-4000-8700-000000000004"
	const missing = "00000000-0000-4000-8700-000000000099"
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO warehouses(id,name,address) VALUES($1,'Mändalika source','Owned Street'),($2,'Mändalika dest','Owned Road')`, source, dest)
	exec(`INSERT INTO transfers(id,source_warehouse_id,dest_warehouse_id,status) VALUES($1,$2,$3,'completed')`, transfer, source, dest)
	exec(`INSERT INTO ingredient_transfers(id,source_warehouse_id,dest_warehouse_id,status) VALUES($1,$2,$3,'completed')`, ingredient, source, dest)
	repo := read.New(pool)
	t.Run("KC04-real-transfer-repository", func(t *testing.T) {
		v, err := repo.Transfer(ctx, transfer)
		if err != nil {
			t.Fatal(err)
		}
		sender, err := v.SenderLetterhead.Get()
		if err != nil || sender.LocationName != "Mändalika source" || len(sender.AddressLines) != 1 {
			t.Fatal("sender", err, sender)
		}
		receiver, err := v.ReceiverLetterhead.Get()
		if err != nil || receiver.LocationName != "Mändalika dest" {
			t.Fatal("receiver", err)
		}
		rows, total, err := repo.Transfers(ctx, "completed", "", "", "warehouse", source, 1, 50)
		if err != nil || total != 1 || len(rows) != 1 {
			t.Fatal("list", err, total)
		}
		for _, row := range rows {
			b, err := json.Marshal(row)
			if err != nil || !strings.Contains(string(b), "senderLetterhead") {
				t.Fatal("serializer", err)
			}
		}
	})
	t.Run("KC04-real-ingredient-repository", func(t *testing.T) {
		v, err := repo.IngredientTransfer(ctx, ingredient)
		if err != nil {
			t.Fatal(err)
		}
		sender, err := v.SenderLetterhead.Get()
		if err != nil || sender.LocationName != "Mändalika source" {
			t.Fatal("sender", err)
		}
		if _, err := v.ReceiverLetterhead.Get(); err != nil {
			t.Fatal(err)
		}
		rows, total, err := repo.IngredientTransfers(ctx, 1, 50, "completed", "", "", "warehouse", source)
		if err != nil || total != 1 || len(rows) != 1 {
			t.Fatal("list", err, total)
		}
		if rows[0].SenderLetterhead.IsSpecified() || rows[0].ReceiverLetterhead.IsSpecified() {
			t.Fatal("list fabricated absent letterheads")
		}
		b, err := json.Marshal(rows[0])
		if err != nil || strings.Contains(string(b), "Letterhead") {
			t.Fatal("absent serialized", err)
		}
	})
	// Real handwritten optional handlers and production middleware. No strict
	// router swap. Missing record controls guarantee no stock/recipe mutation.
	h := New(repo, nil, auth.NewStore(pool), write.New(pool), nil, nil, &uploads.Signer{})
	secret := []byte("KC-OWNED-SYNTHETIC-AUTH")
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.With(mw.RequirePermission("manage_stock_count")).Post("/stock/{id}", h.CompleteStockCount)
	router.With(mw.RequirePermission("manage_inventory")).Post("/recipe/{variantId}/{versionId}", h.RestoreRecipeVersion)
	router.With(mw.RequirePermission("manage_products")).Post("/sign", h.SignUpload)
	admin, err := auth.IssueAccess(secret, time.Hour, source, "admin", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	cashier, err := auth.IssueAccess(secret, time.Hour, source, "cashier", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var out []string
		for _, table := range []string{"stock_counts", "stock_count_items", "outlet_variant_stock", "transfers", "ingredient_transfers", "recipe_versions", "refresh_tokens"} {
			var s string
			if err := pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(x) v FROM `+table+` x) q`).Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		return strings.Join(out, "\n")
	}
	for _, route := range []struct {
		name, path string
		expected   int
	}{{"stock", "/stock/" + missing, 404}, {"recipe", "/recipe/" + missing + "/" + missing, 400}, {"sign-unconfigured", "/sign", 503}} {
		t.Run("KC06-"+route.name, func(t *testing.T) {
			for _, body := range []string{"", " \n", "{}", "null", "{"} {
				before := snapshot()
				for _, access := range []struct {
					token string
					code  int
				}{{"", 401}, {cashier, 403}, {admin, route.expected}} {
					r := httptest.NewRequest("POST", route.path, strings.NewReader(body))
					if access.token != "" {
						r.Header.Set("Authorization", "Bearer "+access.token)
					}
					w := httptest.NewRecorder()
					router.ServeHTTP(w, r)
					if w.Code != access.code {
						t.Fatalf("body=%q got=%d want=%d response=%s", body, w.Code, access.code, w.Body.String())
					}
				}
				if before != snapshot() {
					t.Fatal("unexpected mutation")
				}
			}
		})
	}
	t.Run("KC06-public-logout-empty-and-malformed", func(t *testing.T) {
		a := auth.NewHandler(&config.Config{}, auth.NewStore(pool), nil)
		for _, body := range []string{"", " \n", "{}", "null", "{"} {
			before := snapshot()
			w := httptest.NewRecorder()
			a.Logout(w, httptest.NewRequest(http.MethodPost, "/auth/logout", strings.NewReader(body)))
			if w.Code != 200 {
				t.Fatal(w.Code)
			}
			if before != snapshot() {
				t.Fatal("logout changed state without valid token")
			}
		}
	})
}
