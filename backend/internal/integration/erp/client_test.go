package erp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "k-test-secret-0123456789"

// recorder captures Sleep calls so tests never wait.
type recorder struct {
	mu    sync.Mutex
	waits []time.Duration
}

func (r *recorder) sleep(_ context.Context, d time.Duration) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.waits = append(r.waits, d)
	return nil
}

func newTestClient(t *testing.T, h http.Handler, rec *recorder) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := NewClient(ClientOptions{BaseURL: srv.URL + "/api/integration/v1", APIKey: testKey, Sleep: rec.sleep})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func emptyPage(items string, next string) string {
	return `{"status":"success","data":{"items":[` + items + `],"next_cursor":` + next + `,"server_time":"2026-10-22T01:02:03Z"}}`
}

const notFoundBody = `{"success":false,"error":"Not Found","message":"outlet not found","code":"NOT_FOUND","requestId":"req-1"}`

func outletJSON(slug, code string) string {
	return `{"slug":"` + slug + `","code":"` + code + `","name":"N","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","deleted_at":null}`
}

func TestNewClientValidation(t *testing.T) {
	for name, o := range map[string]ClientOptions{
		"empty base url": {APIKey: testKey},
		"empty api key":  {BaseURL: "https://erp.example.com/api/integration/v1"},
	} {
		if _, err := NewClient(o); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestSendsBearerKey(t *testing.T) {
	var got string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		writeJSON(w, 200, emptyPage("", "null"))
	}), &recorder{})
	if _, err := c.FinishedGoodsPage(context.Background(), PageRequest{}); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer "+testKey {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestUpdatedSinceSentAsUTCWithoutPlus(t *testing.T) {
	var rawQuery string
	var parsed time.Time
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawQuery = r.URL.RawQuery
		var err error
		parsed, err = time.Parse(time.RFC3339, r.URL.Query().Get("updated_since"))
		if err != nil {
			writeJSON(w, 422, `{"success":false,"code":"VALIDATION_ERROR","message":"bad updated_since"}`)
			return
		}
		writeJSON(w, 200, emptyPage("", "null"))
	}), &recorder{})
	wib := time.FixedZone("WIB", 7*3600)
	since := time.Date(2026, 10, 22, 8, 30, 0, 0, wib)
	cur := "abc"
	if _, err := c.FinishedGoodsPage(context.Background(), PageRequest{UpdatedSince: &since, Cursor: &cur}); err != nil {
		t.Fatal(err)
	}
	if !parsed.Equal(since) {
		t.Fatalf("server saw %v, want same instant as %v", parsed, since)
	}
	if strings.Contains(rawQuery, "+") {
		t.Fatalf("raw query has a literal '+': %q", rawQuery)
	}
	if !strings.Contains(rawQuery, "cursor=abc") || !strings.Contains(rawQuery, "take=500") {
		t.Fatalf("query = %q, want cursor and default take", rawQuery)
	}
}

func TestRetryAfterThenSuccess(t *testing.T) {
	calls := 0
	rec := &recorder{}
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "2")
			writeJSON(w, 429, `{"success":false,"code":"RATE_LIMIT_EXCEEDED","message":"slow down"}`)
			return
		}
		writeJSON(w, 200, emptyPage(outletJSON("s", "c"), "null"))
	}), rec)
	pg, err := c.OutletsPage(context.Background(), PageRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pg.Items) != 1 || pg.NextCursor != nil || pg.ServerTime.IsZero() {
		t.Fatalf("page = %+v", pg)
	}
	if len(rec.waits) != 1 || rec.waits[0] != 2*time.Second {
		t.Fatalf("waits = %v, want [2s]", rec.waits)
	}
}

func TestBusyExhaustsAttempts(t *testing.T) {
	calls := 0
	rec := &recorder{}
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Retry-After", "1")
		writeJSON(w, 503, `{"success":false,"code":"INTEGRATION_BUSY","message":"busy","requestId":"r9"}`)
	}), rec)
	_, err := c.FinishedGoodsPage(context.Background(), PageRequest{})
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 503 || ae.Code != "INTEGRATION_BUSY" || ae.RequestID != "r9" {
		t.Fatalf("err = %v", err)
	}
	if calls != defaultMaxAttempts || len(rec.waits) != defaultMaxAttempts-1 {
		t.Fatalf("calls=%d waits=%d, want %d and %d", calls, len(rec.waits), defaultMaxAttempts, defaultMaxAttempts-1)
	}
}

func TestRetryWaitParsing(t *testing.T) {
	c := &Client{maxRetryWait: 10 * time.Second}
	type want struct {
		d  time.Duration
		ok bool
	}
	for h, w := range map[string]want{
		"":                     {time.Second, true},
		"garbage":              {time.Second, true},
		"-1":                   {time.Second, true},
		"3":                    {3 * time.Second, true},
		"10":                   {10 * time.Second, true},
		"11":                   {10 * time.Second, false},
		"999":                  {10 * time.Second, false},
		"10000000000":          {10 * time.Second, false}, // would overflow Duration if multiplied first
		"99999999999999999999": {10 * time.Second, false}, // out of int64 range
	} {
		if d, ok := c.retryWait(h); d != w.d || ok != w.ok {
			t.Errorf("retryWait(%q) = %v,%v; want %v,%v", h, d, ok, w.d, w.ok)
		}
	}
	if _, ok := c.retryWait(time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)); ok {
		t.Error("HTTP-date an hour ahead must exceed the cap")
	}
	if d, ok := c.retryWait(time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)); d != 0 || !ok {
		t.Errorf("HTTP-date in the past = %v,%v; want 0,true", d, ok)
	}
}

// A Retry-After beyond MaxRetryWait (an IP block) fails at once: no early retry.
func TestRetryAfterBeyondCapFailsWithoutSleeping(t *testing.T) {
	rec := &recorder{}
	calls := 0
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Retry-After", "300")
		writeJSON(w, 429, `{"success":false,"code":"RATE_LIMIT_BLOCKED","message":"blocked","requestId":"r"}`)
	}), rec)
	_, err := c.OutletsPage(context.Background(), PageRequest{})
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 429 || ae.Code != "RATE_LIMIT_BLOCKED" || ae.RetryAfter != 10*time.Second {
		t.Fatalf("err = %#v, want 429 RATE_LIMIT_BLOCKED with RetryAfter", err)
	}
	if calls != 1 || len(rec.waits) != 0 {
		t.Fatalf("calls=%d waits=%v; want 1 call and no sleep", calls, rec.waits)
	}
}

// A 429 whose JSON body is truncated keeps its status and is still retried.
func TestUndecodableErrorBodyKeepsStatusAndRetries(t *testing.T) {
	rec := &recorder{}
	calls := 0
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 429, `{"success":fal`)
			return
		}
		writeJSON(w, 200, emptyPage("", "null"))
	}), rec)
	if _, err := c.OutletsPage(context.Background(), PageRequest{}); err != nil {
		t.Fatalf("err = %v, want success after one retry", err)
	}
	if calls != 2 || len(rec.waits) != 1 {
		t.Fatalf("calls=%d waits=%v", calls, rec.waits)
	}
}

// A bare 404 (no ERP NOT_FOUND envelope, e.g. a wrong base URL) is not ErrERPNotFound.
func TestBare404IsNotErrNotFound(t *testing.T) {
	c := newTestClient(t, http.NotFoundHandler(), &recorder{})
	_, err := c.OutletStock(context.Background(), "KMG", nil)
	var ae *APIError
	if errors.Is(err, ErrERPNotFound) || !errors.As(err, &ae) || ae.Status != 404 {
		t.Fatalf("err = %v, want a 404 APIError that is not ErrERPNotFound", err)
	}
	_, _, err = c.OutletStockBySlug(context.Background(), "kemang", "KMG", nil)
	if errors.Is(err, ErrERPNotFound) {
		t.Fatalf("OutletStockBySlug err = %v must not read as outlet gone", err)
	}
}

func TestRepeatedCursorStopsPaging(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/stock") {
			writeJSON(w, 200, `{"status":"success","data":{"items":[],"next_cursor":"same","server_time":"2026-10-22T01:02:03Z","last_updated_at":null,"outlet":{"slug":"s","code":"KMG","name":"N","type":"RETAIL"}}}`)
			return
		}
		writeJSON(w, 200, emptyPage(outletJSON("other", "X"), `"same"`))
	}), &recorder{})
	if _, err := c.OutletStock(context.Background(), "KMG", nil); err == nil || !strings.Contains(err.Error(), "repeated") {
		t.Fatalf("OutletStock err = %v, want repeated-cursor error", err)
	}
	if _, _, err := c.FindOutletCodeBySlug(context.Background(), "kemang"); err == nil || !strings.Contains(err.Error(), "repeated") {
		t.Fatalf("FindOutletCodeBySlug err = %v, want repeated-cursor error", err)
	}
}

func TestOutletStockRejectsOversizedFgCodes(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request expected")
	}), &recorder{})
	many := make([]string, 101)
	for i := range many {
		many[i] = "FG" + strconv.Itoa(i)
	}
	if _, err := c.OutletStock(context.Background(), "KMG", many); err == nil {
		t.Fatal("101 codes: want error")
	}
	long := []string{strings.Repeat("A", 1901)}
	if _, err := c.OutletStock(context.Background(), "KMG", long); err == nil {
		t.Fatal("1901 chars: want error")
	}
}

func TestNotFoundIsErrNotFound(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, notFoundBody)
	}), &recorder{})
	_, err := c.OutletStock(context.Background(), "GONE", nil)
	if !errors.Is(err, ErrERPNotFound) {
		t.Fatalf("err = %v, want ErrERPNotFound", err)
	}
}

func TestNonEnvelopeErrorUsesStatusText(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "<html>boom</html>", 502)
	}), &recorder{})
	_, err := c.FinishedGoodsPage(context.Background(), PageRequest{})
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 502 || ae.Code != "" || ae.Message != "Bad Gateway" {
		t.Fatalf("err = %#v", err)
	}
	if strings.Contains(err.Error(), "boom") {
		t.Fatalf("error dumps the body: %v", err)
	}
}

func TestOutletStockFgCodesSingleCall(t *testing.T) {
	calls := 0
	var q string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		q = r.URL.RawQuery
		writeJSON(w, 200, `{"status":"success","data":{"items":[{"fg_code":"A","fg_name":"a","fg_slug":"a","qty":0,"updated_at":null}],"next_cursor":null,"last_updated_at":null,"outlet":{"code":"O","slug":"o","name":"o"},"server_time":"2026-10-22T01:02:03Z"}}`)
	}), &recorder{})
	items, err := c.OutletStock(context.Background(), "O1", []string{"A", "B"})
	if err != nil || len(items) != 1 || calls != 1 {
		t.Fatalf("items=%v err=%v calls=%d", items, err, calls)
	}
	if !strings.Contains(q, "fg_codes=A%2CB") && !strings.Contains(q, "fg_codes=A,B") {
		t.Fatalf("query = %q", q)
	}
	if strings.Contains(q, "take") || strings.Contains(q, "cursor") {
		t.Fatalf("take/cursor sent with fg_codes: %q", q)
	}
}

func TestOutletStockPagesWithoutFgCodes(t *testing.T) {
	calls := 0
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		next, item := `"p2"`, "a"
		if r.URL.Query().Get("cursor") == "p2" {
			next, item = "null", "b"
		}
		writeJSON(w, 200, `{"status":"success","data":{"items":[{"fg_code":"`+item+`","fg_name":"n","fg_slug":"`+item+`","qty":1,"updated_at":null}],"next_cursor":`+next+`,"last_updated_at":null,"outlet":{"code":"O","slug":"o","name":"o"},"server_time":"2026-10-22T01:02:03Z"}}`)
	}), &recorder{})
	items, err := c.OutletStock(context.Background(), "O1", nil)
	if err != nil || len(items) != 2 || calls != 2 {
		t.Fatalf("items=%v err=%v calls=%d", items, err, calls)
	}
}

// slugServer: stock 404s for oldCode, works for newCode; catalog has 2 pages.
func slugServer(catalogSlug string, stockCalls *[]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/catalog/outlets"):
			if r.URL.Query().Get("cursor") == "" {
				writeJSON(w, 200, emptyPage(outletJSON("other", "X1"), `"page2"`))
				return
			}
			writeJSON(w, 200, emptyPage(outletJSON(catalogSlug, "NEW"), "null"))
		case strings.Contains(r.URL.Path, "/outlets/") && strings.HasSuffix(r.URL.Path, "/stock"):
			parts := strings.Split(r.URL.Path, "/")
			code := parts[len(parts)-2]
			*stockCalls = append(*stockCalls, code)
			if code != "NEW" {
				writeJSON(w, 404, notFoundBody)
				return
			}
			writeJSON(w, 200, `{"status":"success","data":{"items":[{"fg_code":"A","fg_name":"a","fg_slug":"a","qty":3,"updated_at":null}],"next_cursor":null,"last_updated_at":null,"outlet":{"code":"NEW","slug":"s","name":"s"},"server_time":"2026-10-22T01:02:03Z"}}`)
		default:
			http.NotFound(w, r)
		}
	})
}

func TestOutletStockBySlugFollowsRename(t *testing.T) {
	var calls []string
	c := newTestClient(t, slugServer("s", &calls), &recorder{})
	items, code, err := c.OutletStockBySlug(context.Background(), "s", "OLD", nil)
	if err != nil || code != "NEW" || len(items) != 1 || items[0].Qty != 3 {
		t.Fatalf("items=%v code=%q err=%v", items, code, err)
	}
	if strings.Join(calls, ",") != "OLD,NEW" {
		t.Fatalf("stock calls = %v", calls)
	}
}

func TestOutletStockBySlugGone(t *testing.T) {
	var calls []string
	c := newTestClient(t, slugServer("someone-else", &calls), &recorder{})
	// catalog returns slug "someone-else" only; "s" is gone.
	_, code, err := c.OutletStockBySlug(context.Background(), "s", "OLD", nil)
	if !errors.Is(err, ErrERPNotFound) || code != "OLD" {
		t.Fatalf("code=%q err=%v", code, err)
	}
	if len(calls) != 1 {
		t.Fatalf("stock calls = %v, want only the first", calls)
	}
}

func TestOutletStockBySlugKnownCodeWorks(t *testing.T) {
	var calls []string
	c := newTestClient(t, slugServer("s", &calls), &recorder{})
	_, code, err := c.OutletStockBySlug(context.Background(), "s", "NEW", nil)
	if err != nil || code != "NEW" || len(calls) != 1 {
		t.Fatalf("code=%q err=%v calls=%v", code, err, calls)
	}
}

func TestErrorsNeverContainAPIKey(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 401, `{"success":false,"code":"INTEGRATION_UNAUTHORIZED","message":"bad key"}`)
	}), &recorder{})
	_, err := c.FinishedGoodsPage(context.Background(), PageRequest{})
	if err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("err = %v", err)
	}
	// Transport failure path (server closed) must not leak it either.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c2, _ := NewClient(ClientOptions{BaseURL: url, APIKey: testKey, Sleep: (&recorder{}).sleep})
	_, err = c2.FinishedGoodsPage(context.Background(), PageRequest{})
	if err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("transport err = %v", err)
	}
}

func TestContextCancelNotRetried(t *testing.T) {
	calls := 0
	rec := &recorder{}
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }), rec)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.FinishedGoodsPage(ctx, PageRequest{})
	if !errors.Is(err, context.Canceled) || calls != 0 || len(rec.waits) != 0 {
		t.Fatalf("err=%v calls=%d waits=%v", err, calls, rec.waits)
	}
}
