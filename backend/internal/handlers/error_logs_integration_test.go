package handlers_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/handlers"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// TestErrorLogsPostgres (A37): error_logs redaction on the server, atomic batch
// insert, 60-day retention (batched, advisory-locked), the 60-day read bound and
// the admin-only read, all against a real PostgreSQL through the FULL router.
// Opt-in synthetic cluster only; no subtest may skip.
func TestErrorLogsPostgres(t *testing.T) {
	pool, ctx := handlers.GatePool(t, "EL", 26459)
	g := newAUGate(t, pool, ctx)
	srv := g.router(g.disabledCache(t))
	wr := write.New(pool)

	_, adminMail := g.newUser("admin")
	_, mgrMail := g.newUser("manager")
	_, cashMail := g.newUser("cashier")
	admin, mgr, cash := g.mustLogin(srv, adminMail).Access, g.mustLogin(srv, mgrMail).Access, g.mustLogin(srv, cashMail).Access
	get := func(tok string) (int, string) {
		w := g.call(srv, "GET", "/api/v1/error-logs?limit=100", "", tok, g.nextIP())
		return w.Code, w.Body.String()
	}
	rows := func(where string) int { return g.count(`SELECT count(*) FROM error_logs WHERE ` + where) }

	canaries := []string{"CANARY-PIN", "081234567890", "budi@example.com", "CANARY.AAA.BBB", "CANARY-URL"}
	assertClean := func(t *testing.T, where string) {
		t.Helper()
		var raw string
		if err := pool.QueryRow(ctx, `SELECT coalesce(string_agg(row_to_json(e)::text, '|'), '') FROM error_logs e WHERE `+where).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if raw == "" {
			t.Fatal("expected stored rows")
		}
		for _, c := range canaries {
			if strings.Contains(raw, c) {
				t.Fatalf("%q survived in a stored row: %s", c, raw)
			}
		}
	}

	t.Run("canaries POSTed through the router never reach the stored row", func(t *testing.T) {
		item := map[string]any{
			"source": "sync", "kind": "dead_letter", "action": "GET /x?token=CANARY-URL",
			"message": "gagal untuk 081234567890 (budi@example.com) Bearer CANARY.AAA.BBB",
			"payload": map[string]any{"orderId": "ord-1", "customerPhone": "081234567890",
				"steps": []any{map[string]any{"pin": "CANARY-PIN", "note": "hubungi budi@example.com"}}},
			"breadcrumbs": []any{map[string]any{"at": "t", "label": "pilih 081234567890"}},
			"appVersion":  "pos-test", "deviceId": "dev-el",
		}
		// A lone UTF-16 surrogate and a NUL are what jsonb rejects: they must be stored, cleaned.
		item["payload"].(map[string]any)["lone"] = "LONE-PLACEHOLDER"
		item["payload"].(map[string]any)["nul"] = "NUL-PLACEHOLDER"
		raw, _ := json.Marshal(map[string]any{"items": []any{item}})
		body := strings.NewReplacer("LONE-PLACEHOLDER", `\ud83d`, "NUL-PLACEHOLDER", `a\u0000b`).Replace(string(raw))
		if w := g.call(srv, "POST", "/api/v1/error-logs", body, cash, g.nextIP()); w.Code != 200 {
			t.Fatalf("post: %d %s", w.Code, w.Body.String())
		}
		assertClean(t, `device_id='dev-el'`)
		if rows(`device_id='dev-el' AND payload->>'nul'='ab' AND payload->>'lone'=chr(65533)`) != 1 {
			t.Fatal("NUL must be stripped and the lone surrogate stored as exactly U+FFFD")
		}
		if rows(`device_id='dev-el' AND payload::text LIKE '%ord-1%'`) != 1 {
			t.Fatal("non-sensitive ids must survive redaction")
		}
	})

	t.Run("the panic-shaped backend row is redacted too", func(t *testing.T) {
		payload, _ := json.Marshal(map[string]any{"requestId": "req-1", "stack": "goroutine 1 Bearer CANARY.AAA.BBB token=CANARY-URL 081234567890"})
		err := wr.InsertErrorLogs(ctx, []write.ErrorLog{{Source: "backend", Kind: "panic", Action: "POST /x?token=CANARY-URL",
			Message: "panic: failed for budi@example.com 081234567890 Bearer CANARY.AAA.BBB", Payload: payload, DeviceID: "dev-panic"}})
		if err != nil {
			t.Fatal(err)
		}
		assertClean(t, `device_id='dev-panic'`)
	})

	t.Run("a failing row leaves no partial batch", func(t *testing.T) {
		before := rows(`true`)
		err := wr.InsertErrorLogs(ctx, []write.ErrorLog{
			{Source: "runtime", Message: "ok-row"},
			{Source: "runtime", Message: "bad-row", OutletID: "not-a-uuid"},
		})
		if err == nil {
			t.Fatal("expected the bad row to fail the batch")
		}
		if after := rows(`true`); after != before {
			t.Fatalf("partial batch stored: %d -> %d", before, after)
		}
	})

	t.Run("oversize (over 1 MiB) and malformed batches are refused whole", func(t *testing.T) {
		before := rows(`true`)
		big := fmt.Sprintf(`{"items":[{"source":"sync","message":"%s"}]}`, strings.Repeat("a", 1200<<10))
		if w := g.call(srv, "POST", "/api/v1/error-logs", big, cash, g.nextIP()); w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("oversize: %d", w.Code)
		}
		if w := g.call(srv, "POST", "/api/v1/error-logs", `{"items":[`, cash, g.nextIP()); w.Code != http.StatusBadRequest {
			t.Fatalf("malformed: %d", w.Code)
		}
		if rows(`true`) != before {
			t.Fatal("refused batches must store nothing")
		}
	})

	t.Run("more than 50 items keep the first 50 and say how many were accepted", func(t *testing.T) {
		items := make([]any, 55)
		for i := range items {
			items[i] = map[string]any{"source": "sync", "message": fmt.Sprintf("many-%02d", i), "deviceId": "dev-many"}
		}
		raw, _ := json.Marshal(map[string]any{"items": items})
		w := g.call(srv, "POST", "/api/v1/error-logs", string(raw), cash, g.nextIP())
		var env struct {
			OK       bool `json:"ok"`
			Accepted int  `json:"accepted"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &env) != nil || !env.OK || env.Accepted != 50 {
			t.Fatalf("post: %d %s", w.Code, w.Body.String())
		}
		if rows(`device_id='dev-many'`) != 50 || rows(`message='many-49'`) != 1 || rows(`message='many-50'`) != 0 {
			t.Fatal("exactly the first 50 items must be stored")
		}
	})

	t.Run("a POST triggers the due sweep inline, once per interval", func(t *testing.T) {
		h := handlers.New(read.New(pool), nil, auth.NewStore(pool), wr, nil, nil, nil)
		post := func(msg string) int {
			body := fmt.Sprintf(`{"items":[{"source":"runtime","message":%q}]}`, msg)
			w := httptest.NewRecorder()
			h.CreateErrorLogs(w, httptest.NewRequest("POST", "/error-logs", strings.NewReader(body)))
			return w.Code
		}
		g.exec(`INSERT INTO error_logs(source,message,created_at) VALUES('runtime','post-sweep-old-1', now() - interval '65 days')`)
		if post("not-due") != 200 || rows(`message='post-sweep-old-1'`) != 1 {
			t.Fatal("a fresh handler must not sweep on its first POST (startup already did)")
		}
		handlers.ExpireErrorLogSweep(h)
		if post("due") != 200 || rows(`message='post-sweep-old-1'`) != 0 {
			t.Fatal("the due POST must sweep before returning")
		}
		g.exec(`INSERT INTO error_logs(source,message,created_at) VALUES('runtime','post-sweep-old-2', now() - interval '65 days')`)
		if post("throttled") != 200 || rows(`message='post-sweep-old-2'`) != 1 {
			t.Fatal("a second POST inside the interval must not sweep")
		}
		g.exec(`DELETE FROM error_logs WHERE message='post-sweep-old-2'`)
	})

	t.Run("read omits rows older than 60 days", func(t *testing.T) {
		g.exec(`INSERT INTO error_logs(source,message,created_at) VALUES('runtime','OLD-ROW-61d', now() - interval '61 days'),('runtime','RECENT-ROW-59d', now() - interval '59 days')`)
		code, body := get(admin)
		if code != 200 || strings.Contains(body, "OLD-ROW-61d") || !strings.Contains(body, "RECENT-ROW-59d") {
			t.Fatalf("read bound: %d old-present=%v recent-present=%v", code, strings.Contains(body, "OLD-ROW-61d"), strings.Contains(body, "RECENT-ROW-59d"))
		}
	})

	t.Run("sweep deletes old rows in batches and keeps recent ones", func(t *testing.T) {
		g.exec(`INSERT INTO error_logs(source,message,created_at)
			SELECT 'runtime','bulk-old', now() - interval '62 days' - (n||' seconds')::interval FROM generate_series(1,2500) n`)
		oldBefore := rows(`created_at < now() - interval '60 days'`)
		recentBefore := rows(`created_at >= now() - interval '60 days'`)
		n, skipped, err := wr.SweepErrorLogs(ctx, 1000, 1)
		if err != nil || skipped || n != 1000 {
			t.Fatalf("one batch: n=%d skipped=%v err=%v", n, skipped, err)
		}
		n, skipped, err = wr.SweepErrorLogs(ctx, 1000, 20)
		if err != nil || skipped || n != int64(oldBefore-1000) {
			t.Fatalf("rest: n=%d want=%d skipped=%v err=%v", n, oldBefore-1000, skipped, err)
		}
		if rows(`created_at < now() - interval '60 days'`) != 0 || rows(`created_at >= now() - interval '60 days'`) != recentBefore {
			t.Fatal("sweep must remove every old row and no recent row")
		}
	})

	t.Run("a concurrent sweep skips while another holds the advisory lock", func(t *testing.T) {
		g.exec(`INSERT INTO error_logs(source,message,created_at) VALUES('runtime','lock-old', now() - interval '70 days')`)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, write.ErrorLogSweepLockKey); err != nil {
			t.Fatal(err)
		}
		n, skipped, err := wr.SweepErrorLogs(ctx, 1000, 20)
		_ = tx.Rollback(ctx)
		if err != nil || !skipped || n != 0 || rows(`message='lock-old'`) != 1 {
			t.Fatalf("locked sweep: n=%d skipped=%v err=%v", n, skipped, err)
		}
		if n, skipped, err = wr.SweepErrorLogs(ctx, 1000, 20); err != nil || skipped || n != 1 {
			t.Fatalf("after unlock: n=%d skipped=%v err=%v", n, skipped, err)
		}
	})

	t.Run("read is admin-only", func(t *testing.T) {
		if code, _ := get(admin); code != 200 {
			t.Fatalf("admin: %d", code)
		}
		if code, _ := get(mgr); code != 403 {
			t.Fatalf("manager: %d", code)
		}
		if code, _ := get(cash); code != 403 {
			t.Fatalf("cashier: %d", code)
		}
		if code, _ := get(""); code != 401 {
			t.Fatalf("anonymous: %d", code)
		}
		if w := g.call(srv, "POST", "/api/v1/error-logs", `{"items":[]}`, "", g.nextIP()); w.Code != 401 {
			t.Fatalf("anonymous post: %d", w.Code)
		}
	})
}
