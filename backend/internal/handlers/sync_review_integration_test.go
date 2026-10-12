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

// Head-office review items: tablets report parked items, head office resolves
// them, the next report returns the resolution. Opt-in synthetic cluster only.
func TestSyncReviewPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_RV_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated sync-review PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56450 || cfg.ConnConfig.Database != "mandalika_rv_synthetic" || cfg.ConnConfig.User != "rv_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_RV_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	const outletA = "00000000-0000-4000-8b00-000000000001"
	const outletB = "00000000-0000-4000-8b00-000000000002"
	const cashierA = "00000000-0000-4000-8b00-000000000011"
	const cashierB = "00000000-0000-4000-8b00-000000000012"
	const headOffice = "00000000-0000-4000-8b00-000000000013"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'RV outlet A'),($2,'RV outlet B')`, outletA, outletB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'a@example.invalid','x','RV cashier A','cashier',$4),
		($2,'b@example.invalid','x','RV cashier B','cashier',$5),
		($3,'ho@example.invalid','x','RV head office','manager',NULL)`, cashierA, cashierB, headOffice, outletA, outletB)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("RV-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string, perms []string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokA := issue(cashierA, "cashier", outletA, nil)
	tokB := issue(cashierB, "cashier", outletB, nil)
	tokHO := issue(headOffice, "manager", "", []string{"resolve_sync_review"})
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/sync/review-items", h.ReportSyncReviewItems)
	router.Group(func(r chi.Router) {
		r.Use(mw.RequirePermission("resolve_sync_review"))
		r.Get("/sync-review-items", h.ListSyncReviewItems)
		r.Post("/sync-review-items/{key}/resolve", h.ResolveSyncReviewItem)
	})
	do := func(method, path, token, body string) (int, string) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	report := func(token string, items ...string) []write.SyncReviewResolution {
		t.Helper()
		code, body := do("POST", "/sync/review-items", token, `{"items":[`+strings.Join(items, ",")+`]}`)
		var out struct {
			Data struct {
				Resolved []write.SyncReviewResolution `json:"resolved"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil {
			t.Fatalf("report: %d %s", code, body)
		}
		return out.Data.Resolved
	}
	item := func(key, code, payload string) string {
		return fmt.Sprintf(`{"idempotencyKey":%q,"type":"refund","reviewCode":%q,"reviewReason":"denied","clientCreatedAt":"2026-10-12T03:00:00Z","payload":%s}`, key, code, payload)
	}
	// Escape ':' the way the backoffice's encodeURIComponent does (url.PathEscape leaves ':' alone).
	resolve := func(token, key, note string) (int, string) {
		return do("POST", "/sync-review-items/"+strings.ReplaceAll(key, ":", "%3A")+"/resolve", token, fmt.Sprintf(`{"note":%q}`, note))
	}
	keyA := "devA:00000000-0000-4000-8b00-0000000000a1"

	t.Run("report stores the item with pin removed and nothing resolved", func(t *testing.T) {
		if got := report(tokA, item(keyA, "forbidden", `{"orderNumber":"BSD-G0007","pin":"1234"}`)); len(got) != 0 {
			t.Fatalf("resolved = %+v", got)
		}
		var outlet, payload string
		if err := pool.QueryRow(ctx, `SELECT outlet_id::text, payload::text FROM sync_review_items WHERE idempotency_key=$1`, keyA).Scan(&outlet, &payload); err != nil {
			t.Fatal(err)
		}
		if outlet != outletA || strings.Contains(payload, "pin") {
			t.Fatalf("outlet=%s payload=%s", outlet, payload)
		}
	})

	t.Run("NUL characters are stored stripped", func(t *testing.T) {
		report(tokA,
			`{"idempotencyKey":"devA:nul","type":"order","reviewReason":"a\u0000b","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{"note":"x\u0000y"}}`,
			`{"idempotencyKey":"devA:surrogate","type":"order","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{"n":"\ud83d"}}`)
		var reason, payload string
		if err := pool.QueryRow(ctx, `SELECT review_reason, payload->>'note' FROM sync_review_items WHERE idempotency_key='devA:nul'`).Scan(&reason, &payload); err != nil {
			t.Fatal(err)
		}
		if reason != "ab" || payload != "xy" {
			t.Fatalf("reason=%q note=%q", reason, payload)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sync_review_items WHERE idempotency_key='devA:surrogate'`).Scan(&n); err != nil || n != 1 {
			t.Fatalf("surrogate item missing: n=%d err=%v", n, err)
		}
	})

	t.Run("another outlet cannot overwrite or learn the item", func(t *testing.T) {
		report(tokB, item(keyA, "rejected", `{}`))
		var code string
		if err := pool.QueryRow(ctx, `SELECT review_code FROM sync_review_items WHERE idempotency_key=$1`, keyA).Scan(&code); err != nil || code != "forbidden" {
			t.Fatalf("code=%q err=%v", code, err)
		}
	})

	// Runs before the appliedOnServer subtest adds three more open items.
	t.Run("list needs the permission", func(t *testing.T) {
		if code, _ := do("GET", "/sync-review-items", tokA, ""); code != 403 {
			t.Fatalf("cashier list = %d", code)
		}
		code, body := do("GET", "/sync-review-items?status=open", tokHO, "")
		var out struct {
			Data      []read.SyncReviewItem `json:"data"`
			Meta      struct{ Total int }   `json:"meta"`
			OpenCount int                   `json:"openCount"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || out.OpenCount != 3 || out.Meta.Total != 3 {
			t.Fatalf("list: %d %s", code, body)
		}
	})

	t.Run("resolve with an escaped key, then the tablet learns it", func(t *testing.T) {
		if code, body := resolve(tokHO, keyA, "  refund manual sudah dibuat  "); code != 200 || !strings.Contains(body, `"note":"refund manual sudah dibuat"`) {
			t.Fatalf("resolve: %d %s", code, body)
		}
		got := report(tokA, item(keyA, "forbidden", `{}`))
		if len(got) != 1 || got[0].Key != keyA || got[0].ResolvedByName != "RV head office" {
			t.Fatalf("resolved = %+v", got)
		}
		if len(report(tokB, item(keyA, "forbidden", `{}`))) != 0 {
			t.Fatal("other outlet learned the resolution")
		}
	})

	t.Run("resolve twice keeps the first note; unknown key is 404; blank note is 400", func(t *testing.T) {
		if code, body := resolve(tokHO, keyA, "second"); code != 200 || !strings.Contains(body, "refund manual sudah dibuat") {
			t.Fatalf("second resolve: %d %s", code, body)
		}
		if code, _ := resolve(tokHO, "devA:missing", "x"); code != 404 {
			t.Fatalf("unknown key = %d", code)
		}
		if code, _ := resolve(tokHO, keyA, "   "); code != 400 {
			t.Fatalf("blank note = %d", code)
		}
	})

	t.Run("re-reporting a resolved item never reopens it", func(t *testing.T) {
		report(tokA, item(keyA, "forbidden", `{}`))
		var open int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sync_review_items WHERE idempotency_key=$1 AND resolved_at IS NULL`, keyA).Scan(&open); err != nil || open != 0 {
			t.Fatalf("reopened: open=%d err=%v", open, err)
		}
	})

	t.Run("appliedOnServer covers receipts, orders and transfer receives", func(t *testing.T) {
		applied := func(key string) bool {
			t.Helper()
			_, body := do("GET", "/sync-review-items?status=open&limit=200", tokHO, "")
			var out struct {
				Data []read.SyncReviewItem `json:"data"`
			}
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				t.Fatal(err)
			}
			for _, it := range out.Data {
				if it.Key == key {
					return it.AppliedOnServer
				}
			}
			t.Fatalf("%s not listed: %s", key, body)
			return false
		}
		report(tokA,
			`{"idempotencyKey":"devA:refund-ok","type":"refund","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`,
			`{"idempotencyKey":"devA:order-ok","type":"order","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`,
			`{"idempotencyKey":"devA:trf-ok","type":"transfer_receive","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`)
		for _, k := range []string{"devA:refund-ok", "devA:order-ok", "devA:trf-ok"} {
			if applied(k) {
				t.Fatalf("%s applied before any server record", k)
			}
		}
		exec(`INSERT INTO operation_receipts(idempotency_key,op_type,scope,fingerprint,outcome) VALUES('devA:refund-ok','refund',$1,'f','{}')`, outletA)
		exec(`INSERT INTO processed_keys(idempotency_key) VALUES('devA:order-ok')`)
		exec(`INSERT INTO transfers(source_outlet_id,dest_outlet_id,status,received_idempotency_key) VALUES($1,$2,'received','devA:trf-ok')`, outletB, outletA)
		for _, k := range []string{"devA:refund-ok", "devA:order-ok", "devA:trf-ok"} {
			if !applied(k) {
				t.Fatalf("%s not flagged applied", k)
			}
		}
	})

	t.Run("bad batch sizes are 400", func(t *testing.T) {
		if code, _ := do("POST", "/sync/review-items", tokA, `{"items":[]}`); code != 400 {
			t.Fatalf("empty = %d", code)
		}
	})
}
