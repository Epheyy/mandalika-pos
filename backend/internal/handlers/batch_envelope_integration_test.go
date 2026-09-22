package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

func TestBatchEnvelopePostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_BE_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated envelope PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56441 || cfg.ConnConfig.Database != "mandalika_be_synthetic" || cfg.ConnConfig.User != "be_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_BE_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture not empty: %d %v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
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
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}
	secret := []byte("BE-SYNTHETIC-TEST-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/shifts", h.OpenShift)
	router.Post("/shifts/{id}/close", h.CloseShift)
	router.Post("/sync/batch", h.SyncBatch)
	request := func(path, raw, access, scope string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", path, strings.NewReader(raw))
		if access != "" {
			r.Header.Set("Authorization", "Bearer "+access)
		}
		if scope != "" {
			r.Header.Set("X-Outlet-Id", scope)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	snapshot := func(excludeShift bool) string {
		t.Helper()
		var parts []string
		for _, table := range []string{"shifts", "cash_flows", "orders", "order_items", "outlet_variant_stock", "customers", "point_transactions", "discount_codes", "promo_reward_grants", "processed_keys"} {
			if excludeShift && table == "shifts" {
				continue
			}
			var value string
			// Closed allowlist only; compare complete rows, not mutation counters.
			if err := pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(x) v FROM `+table+` x) q`).Scan(&value); err != nil {
				t.Fatal(err)
			}
			parts = append(parts, table+value)
		}
		return strings.Join(parts, "\n")
	}

	for _, tc := range invalidBatchEnvelopes() {
		t.Run(tc.name, func(t *testing.T) {
			before := snapshot(false)
			w := request("/sync/batch", tc.raw, token, "")
			if w.Code != 400 || snapshot(false) != before {
				t.Fatalf("rejected envelope changed business rows: %d %s", w.Code, w.Body.String())
			}
		})
	}
	t.Run("empty controls", func(t *testing.T) {
		for _, raw := range []string{`{}`, `{"items":null}`, `{"items":[]}`} {
			before := snapshot(false)
			w := request("/sync/batch", raw, token, "")
			if w.Code != 200 || snapshot(false) != before {
				t.Fatal(w.Code, w.Body.String())
			}
		}
	})
	t.Run("auth boundary", func(t *testing.T) {
		for _, tc := range []struct {
			access, scope string
			want          int
		}{{"", "", 401}, {"invalid.token", "", 401}, {token, "00000000-0000-4000-8000-000000000099", 403}} {
			before := snapshot(false)
			w := request("/sync/batch", `{"items":[`+envelopeValidItem+`]}`, tc.access, tc.scope)
			if w.Code != tc.want || snapshot(false) != before {
				t.Fatal(w.Code, w.Body.String())
			}
		}
	})
	t.Run("aliases and unknown metadata positive", func(t *testing.T) {
		before := snapshot(false)
		other := snapshot(true)
		raw := `{"actor":"forged","future":{"items":null},"ItEmS":[{"TYPE":"shift_open","IDEMPOTENCYKEY":"original-key","PAYLOAD":{"startingCash":0,"role":"admin","outletId":"forged"}}]} ` + "\n\t"
		w := request("/sync/batch", raw, token, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) || snapshot(false) == before || snapshot(true) != other {
			t.Fatal(w.Code, w.Body.String())
		}
		var id, uid string
		var cash float64
		if err := pool.QueryRow(ctx, `SELECT id,cashier_id,starting_cash FROM shifts WHERE outlet_id=$1 AND status='open'`, outlet).Scan(&id, &uid, &cash); err != nil || uid != user || cash != 0 {
			t.Fatal(uid, cash, err)
		}
		if err := svc.CloseShift(ctx, outlet, id, 0, nil); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("mixed semantics and raw payload duplicates", func(t *testing.T) {
		for _, bad := range []string{`{"startingCash":null}`, `{"startingCash":0,"STARTINGCASH":10}`} {
			other := snapshot(true)
			raw := `{"items":[{"type":"shift_open","idempotencyKey":"bad-original","payload":` + bad + `},{"type":"shift_open","idempotencyKey":"good-original","payload":{"startingCash":0}},{"type":"refund","idempotencyKey":"refund-original","payload":{"CanRefund":true,"alreadyPaid":true,"role":"admin"}}]}`
			w := request("/sync/batch", raw, token, "")
			var out struct {
				Data syncpkg.BatchResult `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || out.Data.Processed != 1 || len(out.Data.Results) != 3 || snapshot(true) != other {
				t.Fatal(w.Code, w.Body.String())
			}
			for i, key := range []string{"bad-original", "good-original", "refund-original"} {
				want := "error"
				if i == 1 {
					want = "ok"
				}
				if out.Data.Results[i].IdempotencyKey != key || out.Data.Results[i].Status != want {
					t.Fatal(out)
				}
			}
			if err := svc.CloseShift(ctx, outlet, out.Data.Results[1].OrderID, 0, nil); err != nil {
				t.Fatal(err)
			}
		}
	})
	t.Log("Real raw HTTP, JWT, caller lookup, ProcessBatch and PostgreSQL effects; ten full-row snapshots; synthetic isolated fixture only")
}
