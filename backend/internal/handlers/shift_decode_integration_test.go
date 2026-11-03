package handlers

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestShiftDecodePostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_S0D_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated S0d PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 26440 || cfg.ConnConfig.Database != "mandalika_s0d_synthetic" || cfg.ConnConfig.User != "s0d_test" {
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
	expected := os.Getenv("MANDALIKA_S0D_TEST_DATA_DIR")
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
	secret := []byte("S0D-SYNTHETIC-TEST-KEY")
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
	snapshot := func() string {
		t.Helper()
		var parts []string
		for _, table := range []string{"shifts", "cash_flows", "orders", "order_items", "outlet_variant_stock", "customers", "point_transactions", "discount_codes", "promo_reward_grants", "processed_keys"} {
			var value string
			// Closed allowlist only; compare complete rows, not mutation counters.
			if err := pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(x) v FROM `+table+` x) q`).Scan(&value); err != nil {
				t.Fatal(err)
			}
			parts = append(parts, table+value)
		}
		return strings.Join(parts, "\n")
	}
	newShift := func() string {
		t.Helper()
		id, err := svc.OpenShift(ctx, service.OpenShiftInput{OutletID: outlet, CashierID: user, CashierName: "Synthetic", StartingCash: 100})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	for _, op := range []string{"open", "close"} {
		t.Run("denied/"+op, func(t *testing.T) {
			field, path := "startingCash", "/shifts"
			id := ""
			if op == "close" {
				field = "closingCash"
				id = newShift()
				path = "/shifts/" + id + "/close"
				exec(`UPDATE shifts SET counted_by_method='{"cash":12}'::jsonb WHERE id=$1`, id)
			}
			cases := []string{"", `null`, `[]`, `1`, `{}`, fmt.Sprintf(`{"%s":null}`, field), fmt.Sprintf(`{"%s":"0"}`, field), fmt.Sprintf(`{"%s":1e999}`, field), fmt.Sprintf(`{"%s":1000000000000}`, field), fmt.Sprintf(`{"%s":0,`, field), fmt.Sprintf(`{"%s":0}{}`, field), fmt.Sprintf(`{"%s":0}junk`, field), fmt.Sprintf(`{"%s":0,"%s":1}`, field, field), fmt.Sprintf(`{"%s":0,"%s":1}`, field, strings.ToUpper(field))}
			if op == "close" {
				for _, v := range []string{`{"cash":null}`, `{"cash":"0"}`, `{"cash":1e999}`, `{"cash":0,"cash":1}`, `[]`} {
					cases = append(cases, `{"closingCash":0,"countedByMethod":`+v+`}`)
				}
			} else {
				cases = append(cases, `{"startingCash":0,"outletName":false}`)
			}
			for i, raw := range cases {
				before := snapshot()
				w := request(path, raw, token, "")
				if w.Code != 400 || snapshot() != before {
					t.Fatalf("direct %s: status=%d body=%s", raw, w.Code, w.Body.String())
				}
				batchRaw := raw
				if op == "close" && strings.HasPrefix(raw, "{") {
					batchRaw = `{"shiftId":"` + id + `",` + raw[1:]
				}
				key := fmt.Sprintf("original-%s-%d", op, i)
				item := syncpkg.BatchItem{Type: "shift_" + op, IdempotencyKey: key, Payload: json.RawMessage(batchRaw)}
				if json.Valid([]byte(batchRaw)) {
					body := `{"items":[{"type":"shift_` + op + `","idempotencyKey":"` + key + `","payload":` + batchRaw + `}]}`
					w = request("/sync/batch", body, token, "")
					var out struct {
						Data syncpkg.BatchResult `json:"data"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
						t.Fatal(err)
					}
					if w.Code != 200 || out.Data.Processed != 0 || len(out.Data.Results) != 1 || out.Data.Results[0].Status != "error" || out.Data.Results[0].IdempotencyKey != key {
						t.Fatalf("batch %s: %d %s", raw, w.Code, w.Body.String())
					}
				} else {
					// Malformed payload bytes cannot appear in valid HTTP JSON. Exercise
					// the engine's per-item boundary separately; malformed envelopes are 400.
					out, err := h.Sync.ProcessBatch(ctx, syncpkg.Caller{OutletID: outlet, UserID: user}, []syncpkg.BatchItem{item})
					if err != nil || out.Processed != 0 || out.Results[0].Status != "error" || out.Results[0].IdempotencyKey != key {
						t.Fatalf("engine malformed %+v %v", out, err)
					}
					w = request("/sync/batch", `{"items":[`, token, "")
					if w.Code != 400 {
						t.Fatal(w.Code)
					}
				}
				if snapshot() != before {
					t.Fatalf("denied batch changed rows: %s", raw)
				}
			}
			if op == "close" {
				if err := svc.CloseShift(ctx, outlet, id, 100, nil); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	for _, transport := range []string{"direct", "batch"} {
		t.Run("valid/"+transport, func(t *testing.T) {
			for i, tc := range []struct {
				amount  float64
				counted string
			}{{0, ""}, {125.25, `,"countedByMethod":null`}, {-1.25, `,"countedByMethod":{}`}, {0, `,"countedByMethod":{"cash":0,"custom_BANK":1.25}`}} {
				openBody := fmt.Sprintf(`{"startingCash":%g,"outletName":null,"outletId":"forged","cashierId":"forged","role":"admin","future":true} `, tc.amount)
				var id string
				if transport == "direct" {
					w := request("/shifts", openBody, token, "")
					if w.Code != 201 {
						t.Fatalf("%d %s", w.Code, w.Body.String())
					}
				} else {
					w := request("/sync/batch", fmt.Sprintf(`{"items":[{"type":"shift_open","idempotencyKey":"valid-open-%d","payload":`, i)+openBody+`}]}`, token, "")
					if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
						t.Fatalf("%d %s", w.Code, w.Body.String())
					}
				}
				var cash float64
				var uid string
				if err := pool.QueryRow(ctx, `SELECT id,starting_cash,cashier_id FROM shifts WHERE outlet_id=$1 AND status='open'`, outlet).Scan(&id, &cash, &uid); err != nil || cash != tc.amount || uid != user {
					t.Fatalf("cash=%v uid=%s err=%v", cash, uid, err)
				}
				exec(`UPDATE shifts SET counted_by_method='{"cash":12}'::jsonb WHERE id=$1`, id)
				closeBody := fmt.Sprintf(`{"closingCash":%g%s,"shiftId":"%s","outletId":"forged"} `, tc.amount, tc.counted, id)
				if transport == "direct" {
					w := request("/shifts/"+id+"/close", strings.Replace(closeBody, id, "forged", 1), token, "")
					if w.Code != 200 {
						t.Fatalf("%d %s", w.Code, w.Body.String())
					}
				} else {
					w := request("/sync/batch", fmt.Sprintf(`{"items":[{"type":"shift_close","idempotencyKey":"valid-close-%d","payload":`, i)+closeBody+`}]}`, token, "")
					if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
						t.Fatalf("%d %s", w.Code, w.Body.String())
					}
				}
				var status, counts string
				if err := pool.QueryRow(ctx, `SELECT status,closing_cash,counted_by_method::text FROM shifts WHERE id=$1`, id).Scan(&status, &cash, &counts); err != nil || status != "closed" || cash != tc.amount {
					t.Fatalf("%s %v %v", status, cash, err)
				}
				if tc.counted == "" || tc.counted == `,"countedByMethod":null` || tc.counted == `,"countedByMethod":{}` {
					if counts != `{"cash": 12}` {
						t.Fatal("optional counts overwritten", counts)
					}
				} else {
					var c map[string]float64
					if err := json.Unmarshal([]byte(counts), &c); err != nil || c["cash"] != 0 || c["custom_BANK"] != 1.25 {
						t.Fatal(counts, err)
					}
				}
				before := snapshot()
				w := request("/shifts/"+id+"/close", `{"closingCash":777}`, token, "")
				if w.Code != 200 || snapshot() != before {
					t.Fatal("existing close retry semantics changed")
				}
			}
		})
	}
	t.Run("trusted auth and mixed batch", func(t *testing.T) {
		before := snapshot()
		for _, tc := range []struct {
			access, scope string
			status        int
		}{{"", "", 401}, {token, "00000000-0000-4000-8000-000000000999", 403}} {
			w := request("/shifts", `{"startingCash":0,"role":"admin"}`, tc.access, tc.scope)
			if w.Code != tc.status || snapshot() != before {
				t.Fatal(w.Code, w.Body.String())
			}
		}
		body := `{"items":[{"type":"shift_open","idempotencyKey":"invalid-original","payload":{"startingCash":null}},{"type":"shift_open","idempotencyKey":"valid-original","payload":{"startingCash":0}},{"type":"refund","idempotencyKey":"denied-refund","payload":{"CanRefund":true}}]}`
		w := request("/sync/batch", body, token, "")
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || out.Data.Processed != 1 || len(out.Data.Results) != 3 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		for i, want := range []string{"error", "ok", "error"} {
			if out.Data.Results[i].Status != want {
				t.Fatal(out)
			}
		}
		for i, key := range []string{"invalid-original", "valid-original", "denied-refund"} {
			if out.Data.Results[i].IdempotencyKey != key {
				t.Fatal(out)
			}
		}
		id := out.Data.Results[1].OrderID
		before = snapshot()
		// Batch close needs its reference; null/absent cannot target another shift.
		for _, suffix := range []string{"", `,"shiftId":null`, `,"shiftId":""`} {
			w = request("/sync/batch", `{"items":[{"type":"shift_close","idempotencyKey":"missing-id","payload":{"closingCash":0`+suffix+`}}]}`, token, "")
			if !strings.Contains(w.Body.String(), `"status":"error"`) || snapshot() != before {
				t.Fatal(w.Body.String())
			}
		}
		if err := svc.CloseShift(ctx, outlet, id, 0, nil); err != nil {
			t.Fatal(err)
		}
	})
	t.Log("Real JWT, caller enrichment, chi routes, shift services, DB/readback; all 45 existing migrations. No Redis/device/payment-provider or universal open-shift idempotency evidence.")
}
