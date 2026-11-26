package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// TestCrossOutletLookupGuardPostgres is gate XL (isolated cluster, MANDALIKA_XL_TEST_DSN, port 26487):
// the A18 lookup's per-user limit and its log. The 21st lookup in a window is a 429 with Retry-After,
// every attempt (limited ones too) leaves a row, a phone is stored masked, a failed log write fails
// closed (503, no results) and the log read is admin-only.
func TestCrossOutletLookupGuardPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "XL", 26487)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
	}
	count := func(sql string, args ...any) (n int) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return
	}

	const (
		outX  = "00000000-0000-4000-8f87-0000000000a1"
		outY  = "00000000-0000-4000-8f87-0000000000a2"
		userX = "00000000-0000-4000-8f87-0000000000b1"
		userY = "00000000-0000-4000-8f87-0000000000b2"
		userZ = "00000000-0000-4000-8f87-0000000000b3"
		admin = "00000000-0000-4000-8f87-0000000000b4"
	)
	exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'XL outlet X','xl-x','XLX'),($2,'XL outlet Y','xl-y','XLY')`, outX, outY)
	for i, u := range []struct{ id, out string }{{userX, outX}, {userY, outY}, {userZ, outY}} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x','XL cashier','cashier',$3)`,
			u.id, "xl"+strconv.Itoa(i)+"@example.invalid", u.out)
	}
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'xladmin@example.invalid','x','XL admin','admin')`, admin)
	// One sale at X so a lookup from Y has something to find.
	exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status)
	      VALUES('00000000-0000-4000-8f87-0000000000e1','00000000-0000-4000-8f87-0000000000e2','XL-ORD-0001','xl-dev:e2',$1,$2,'xl-cashier',100000,100000,'cash','completed')`, outX, userX)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	cc, err := cache.Connect(context.Background(), "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("XL-INTEGRATION-SYNTHETIC-KEY-0123456789")
	h := New(rd, cc, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	h.SetCrossOutletLookupLimit(20, 10*time.Minute)
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("process_refund")).Get("/cross-outlet-returns/lookup", h.CrossOutletLookup)
	router.With(authWrap, mw.RequireRole("admin")).Get("/cross-outlet-returns/lookups", h.CrossOutletLookups)

	tok := func(user, role, outlet string, perms ...string) string {
		s, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	get := func(path, token string) (int, []byte, http.Header) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes(), w.Header()
	}
	kasirY := tok(userY, "cashier", outY, "process_refund")
	kasirZ := tok(userZ, "cashier", outY, "process_refund")
	kasirNoPerm := tok(userX, "cashier", outX)
	adminTok := tok(admin, "admin", "")

	// 1. A found sale is logged with the order number as typed, the device and the result count.
	if code, raw, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-ORD-0001&deviceId=tab-1", kasirY); code != 200 {
		t.Fatalf("lookup %d %s", code, raw)
	}
	var kind, value, device string
	var results int
	var limited bool
	if err := pool.QueryRow(ctx, `SELECT query_kind,query_value,COALESCE(device_id,''),result_count,rate_limited
	      FROM cross_outlet_lookups WHERE user_id=$1`, userY).Scan(&kind, &value, &device, &results, &limited); err != nil {
		t.Fatal(err)
	}
	if kind != "order_number" || value != "XL-ORD-0001" || device != "tab-1" || results != 1 || limited {
		t.Fatalf("log row = %s %s %s %d %v", kind, value, device, results, limited)
	}

	// 2. A phone is stored masked to its last 4 digits, never in full.
	if code, raw, _ := get("/cross-outlet-returns/lookup?phone=0812-3456-7890", kasirY); code != 200 {
		t.Fatalf("phone lookup %d %s", code, raw)
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE query_kind='phone' AND query_value='****7890'`); got != 1 {
		t.Fatalf("masked phone rows = %d", got)
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE query_value LIKE '%12345%' OR query_value LIKE '%081%'`); got != 0 {
		t.Fatal("a full phone number reached the log")
	}

	// 3. Lookups 3..20 pass; the 21st is a 429 with Retry-After and is itself logged.
	for i := 3; i <= 20; i++ {
		if code, raw, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-NONE-"+strconv.Itoa(i), kasirY); code != 200 {
			t.Fatalf("lookup %d: %d %s", i, code, raw)
		}
	}
	code, raw, hdr := get("/cross-outlet-returns/lookup?orderNumber=XL-ORD-0001", kasirY)
	if code != http.StatusTooManyRequests {
		t.Fatalf("21st lookup = %d %s, want 429", code, raw)
	}
	if ra, _ := strconv.Atoi(hdr.Get("Retry-After")); ra < 1 || ra > 600 {
		t.Fatalf("Retry-After = %q", hdr.Get("Retry-After"))
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE user_id=$1`, userY); got != 21 {
		t.Fatalf("rows after 21 attempts = %d, want 21", got)
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE user_id=$1 AND rate_limited AND result_count=0`, userY); got != 1 {
		t.Fatalf("rate-limited rows = %d, want 1", got)
	}
	// Rate-limited rows are capped per window: 9 more refused attempts add 4 rows (5 in all), still 429.
	for i := 0; i < 9; i++ {
		if code, _, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-ORD-0001", kasirY); code != http.StatusTooManyRequests {
			t.Fatalf("refused attempt %d = %d", i, code)
		}
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE user_id=$1 AND rate_limited`, userY); got != 5 {
		t.Fatalf("rate-limited rows = %d, want the cap of 5", got)
	}
	// The limited answer carries no sale data.
	if json.Valid(raw) && len(raw) > 400 {
		t.Fatalf("429 body looks like data: %s", raw)
	}

	// 4. The limit is per user: a colleague at the same outlet still searches.
	if code, raw, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-ORD-0001", kasirZ); code != 200 {
		t.Fatalf("other user = %d %s", code, raw)
	}

	// 4b. A phone typed with odd punctuation reaches the server as an order number: still masked in the log.
	if code, raw, _ := get("/cross-outlet-returns/lookup?orderNumber=0812.3456.9999", kasirZ); code != 200 {
		t.Fatalf("dotted phone = %d %s", code, raw)
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups WHERE query_value='****9999'`); got != 1 {
		t.Fatalf("masked dotted phone rows = %d", got)
	}

	// 5. A bad request (both/neither param) is not counted or logged.
	before := count(`SELECT count(*) FROM cross_outlet_lookups`)
	if code, _, _ := get("/cross-outlet-returns/lookup", kasirZ); code != 400 {
		t.Fatalf("neither param = %d", code)
	}
	if got := count(`SELECT count(*) FROM cross_outlet_lookups`); got != before {
		t.Fatal("a 400 request was logged")
	}

	// 6. The window resets: the same user with a window already over gets through again. A 1 s window
	// is used so the test waits for a real bucket change instead of faking the clock.
	h.SetCrossOutletLookupLimit(1, time.Second)
	waitBucket := func() { time.Sleep(time.Duration(1000-time.Now().UnixMilli()%1000+50) * time.Millisecond) }
	waitBucket()
	if code, _, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-RESET-1", kasirZ); code != 200 {
		t.Fatalf("first in window = %d", code)
	}
	if code, _, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-RESET-2", kasirZ); code != http.StatusTooManyRequests {
		t.Fatalf("second in the same window = %d, want 429", code)
	}
	waitBucket()
	if code, _, _ := get("/cross-outlet-returns/lookup?orderNumber=XL-RESET-3", kasirZ); code != 200 {
		t.Fatalf("after the window = %d, want 200", code)
	}
	h.SetCrossOutletLookupLimit(1000, 10*time.Minute)

	// 7. Fail closed: a failed log write answers 503 + Retry-After and returns no results.
	h.xoLog = func(context.Context, xoLookupRow) error { return errors.New("log down") }
	code, raw, hdr = get("/cross-outlet-returns/lookup?orderNumber=XL-ORD-0001", kasirY)
	if code != http.StatusServiceUnavailable || hdr.Get("Retry-After") == "" {
		t.Fatalf("log failure = %d retry=%q", code, hdr.Get("Retry-After"))
	}
	if len(raw) > 300 {
		t.Fatalf("503 carries data: %s", raw)
	}
	h.xoLog = nil

	// 8. The log read is admin-only and paginated, newest first, with the filters.
	if code, _, _ := get("/cross-outlet-returns/lookups", kasirY); code != http.StatusForbidden {
		t.Fatalf("cashier reading the log = %d", code)
	}
	if code, _, _ := get("/cross-outlet-returns/lookups", kasirNoPerm); code != http.StatusForbidden {
		t.Fatalf("cashier reading the log = %d", code)
	}
	var list struct {
		Data []struct {
			UserID      string `json:"userId"`
			UserName    string `json:"userName"`
			OutletName  string `json:"outletName"`
			QueryKind   string `json:"queryKind"`
			QueryValue  string `json:"queryValue"`
			RateLimited bool   `json:"rateLimited"`
			CreatedAt   string `json:"createdAt"`
		} `json:"data"`
		Meta struct {
			Total int `json:"total"`
		} `json:"meta"`
	}
	code, raw, _ = get("/cross-outlet-returns/lookups?userId="+userY+"&limit=5", adminTok)
	if code != 200 || json.Unmarshal(raw, &list) != nil {
		t.Fatalf("admin list %d %s", code, raw)
	}
	if list.Meta.Total != 25 || len(list.Data) != 5 {
		t.Fatalf("total %d rows %d, want 25/5", list.Meta.Total, len(list.Data))
	}
	if !list.Data[0].RateLimited || list.Data[0].OutletName != "XL outlet Y" || list.Data[0].UserName != "XL cashier" {
		t.Fatalf("newest row = %+v", list.Data[0])
	}
	for i := 1; i < len(list.Data); i++ {
		if list.Data[i-1].CreatedAt < list.Data[i].CreatedAt {
			t.Fatal("not newest first")
		}
	}
	code, raw, _ = get("/cross-outlet-returns/lookups?userId="+userY+"&outletId="+outX, adminTok)
	if code != 200 || json.Unmarshal(raw, &list) != nil || list.Meta.Total != 0 {
		t.Fatalf("outlet filter %d %s", code, raw)
	}
	if code, _, _ := get("/cross-outlet-returns/lookups?from=2099-01-01", adminTok); code != 200 {
		t.Fatalf("from filter = %d", code)
	}
	if code, _, _ := get("/cross-outlet-returns/lookups?userId=nope", adminTok); code != 400 {
		t.Fatalf("bad userId = %d", code)
	}
	if code, _, _ := get("/cross-outlet-returns/lookups?to=not-a-date", adminTok); code != 400 {
		t.Fatalf("bad date = %d", code)
	}
}
