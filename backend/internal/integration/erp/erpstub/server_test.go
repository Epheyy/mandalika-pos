package erpstub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "test-key"

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type env struct {
	t     *testing.T
	s     *Server
	clock *testClock
}

func newEnv(t *testing.T, statePath string) *env {
	t.Helper()
	clock := &testClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	s, err := New(Config{Key: testKey, StatePath: statePath, Now: clock.Now})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return &env{t: t, s: s, clock: clock}
}

func (e *env) do(method, target string, body []byte, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.s.ServeHTTP(rec, req)
	return rec
}

func (e *env) get(target string) *httptest.ResponseRecorder {
	return e.do(http.MethodGet, target, nil, map[string]string{"Authorization": "Bearer " + testKey})
}

func (e *env) postHook(target string, body []byte) *httptest.ResponseRecorder {
	return e.do(http.MethodPost, target, body, map[string]string{"Authorization": "Bearer " + testKey})
}

// post sends a stock document with Idempotency-Key = its document_id.
func (e *env) post(body []byte) *httptest.ResponseRecorder {
	var d struct {
		DocumentID string `json:"document_id"`
	}
	_ = json.Unmarshal(body, &d)
	return e.postKey(body, d.DocumentID)
}

func (e *env) postKey(body []byte, key string) *httptest.ResponseRecorder {
	h := map[string]string{"Authorization": "Bearer " + testKey}
	if key != "" {
		h["Idempotency-Key"] = key
	}
	return e.do(http.MethodPost, "/api/integration/v1/stock-documents", body, h)
}

type resp struct {
	Success bool            `json:"success"`
	Status  string          `json:"status"`
	Data    json.RawMessage `json:"data"`
	Code    string          `json:"code"`
	Details []detail        `json:"details"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) resp {
	t.Helper()
	var r resp
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return r
}

func decodeResult(t *testing.T, rec *httptest.ResponseRecorder) docResult {
	t.Helper()
	var res docResult
	if err := json.Unmarshal(decode(t, rec).Data, &res); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	return res
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return b
}

func uid(n int) string { return fmt.Sprintf("e0000000-0000-4000-8000-%012d", n) }
func mid(n int) string { return fmt.Sprintf("b0000000-0000-4000-8000-%012d", n) }

func ln(m int, fg string, qty any) map[string]any {
	return map[string]any{"movement_id": mid(m), "fg_code": fg, "qty": qty, "reason": "t", "flags": []string{}}
}

func docBody(n int, kind string, lines ...map[string]any) map[string]any {
	return map[string]any{
		"document_id": uid(n),
		"kind":        kind,
		"source":      map[string]any{"system": "pos", "brand": "mandalika", "device_id": "d", "actor": "a"},
		"location":    map[string]any{"type": "outlet", "code": "KMG"},
		"occurred_at": "2026-04-01T10:00:00Z",
		"ref":         map[string]any{"type": "order", "id": fmt.Sprintf("ref-%d", n), "number": "N"},
		"lines":       lines,
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mutate(t *testing.T, body []byte, fn func(map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	fn(m)
	return mustJSON(t, m)
}

func (e *env) docCount() int {
	var docs []docRecord
	if err := json.Unmarshal(decode(e.t, e.get("/_stub/documents")).Data, &docs); err != nil {
		e.t.Fatal(err)
	}
	return len(docs)
}

func (e *env) balances() []balance {
	var rows []balance
	if err := json.Unmarshal(decode(e.t, e.get("/_stub/balances")).Data, &rows); err != nil {
		e.t.Fatal(err)
	}
	return rows
}

func (e *env) qty(locType, locCode, code string) int64 {
	for _, b := range e.balances() {
		if b.LocationType == locType && b.LocationCode == locCode && b.FgCode == code {
			return b.Qty
		}
	}
	return 0
}

func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, want, rec.Body.String())
	}
}

func expectValidation(t *testing.T, rec *httptest.ResponseRecorder) resp {
	t.Helper()
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	r := decode(t, rec)
	if r.Code != "VALIDATION_ERROR" || len(r.Details) == 0 {
		t.Fatalf("want VALIDATION_ERROR with details, got %s", rec.Body.String())
	}
	return r
}

// applyChain posts the section-10 fixtures in order.
func applyChain(t *testing.T, e *env) map[string]docResult {
	t.Helper()
	out := map[string]docResult{}
	steps := []struct {
		name string
		body []byte
	}{
		{"opening", fixture(t, "doc_opening.json")},
		{"sale", fixture(t, "doc_sale.json")},
		{"refund", fixture(t, "doc_refund.json")},
		{"transfer_out", fixture(t, "doc_transfer_out.json")},
		{"transfer_in", fixture(t, "doc_transfer_in.json")},
		{"count", fixture(t, "doc_count.json")},
	}
	for _, s := range steps {
		rec := e.post(s.body)
		expectStatus(t, rec, http.StatusOK)
		res := decodeResult(t, rec)
		if res.Status != "applied" || len(res.MovementIDs) != 1 {
			t.Fatalf("%s: unexpected result %+v", s.name, res)
		}
		out[s.name] = res
	}
	return out
}

func TestSection10Chain(t *testing.T) {
	e := newEnv(t, "")
	res := applyChain(t, e)
	if res["sale"].MovementIDs[0] != "a0000000-0000-4000-8000-000000000002" {
		t.Fatalf("movement ids not in line order: %+v", res["sale"])
	}
	rows := e.balances()
	if len(rows) != 2 {
		t.Fatalf("balances = %+v", rows)
	}
	if e.qty("outlet", "KMG", "FG-001") != 49 || e.qty("outlet", "BSD", "FG-001") != -10 {
		t.Fatalf("final balances wrong: %+v", rows)
	}
	var page stockPage
	rec := e.get("/api/integration/v1/outlets/KMG/stock")
	expectStatus(t, rec, http.StatusOK)
	if err := json.Unmarshal(decode(t, rec).Data, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].FgCode != "FG-001" || page.Items[0].Qty != 49 {
		t.Fatalf("stock = %+v", page.Items)
	}
}

func TestReplayReturnsSameMovementIDs(t *testing.T) {
	e := newEnv(t, "")
	applyChain(t, e)
	docsBefore, balBefore := e.docCount(), e.balances()
	sale := fixture(t, "doc_sale.json")

	rec := e.post(sale)
	expectStatus(t, rec, http.StatusOK)
	res := decodeResult(t, rec)
	if res.Status != "replayed" || len(res.MovementIDs) != 1 || res.MovementIDs[0] != "a0000000-0000-4000-8000-000000000002" {
		t.Fatalf("replay result = %+v", res)
	}

	var m map[string]any
	_ = json.Unmarshal(sale, &m)
	reordered, _ := json.MarshalIndent(m, "  ", "\t") // sorted keys, different whitespace
	rec = e.post(reordered)
	expectStatus(t, rec, http.StatusOK)
	if decodeResult(t, rec).Status != "replayed" {
		t.Fatalf("reordered body not replayed: %s", rec.Body.String())
	}
	if e.docCount() != docsBefore || fmt.Sprint(e.balances()) != fmt.Sprint(balBefore) {
		t.Fatal("replay changed state")
	}
}

func TestERPEnvelopeOnStockDocuments(t *testing.T) {
	clock := &testClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	s, err := New(Config{Key: testKey, Now: clock.Now, Envelope: EnvelopeERP})
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, s: s, clock: clock}
	body := fixture(t, "doc_opening.json")
	for _, want := range []string{"applied", "replayed"} {
		rec := e.post(body)
		expectStatus(t, rec, http.StatusOK)
		r := decode(t, rec)
		if r.Status != "success" || r.Success || strings.Contains(rec.Body.String(), `"success":`) {
			t.Fatalf("%s: want the ERP envelope, got %s", want, rec.Body.String())
		}
		if res := decodeResult(t, rec); res.Status != want {
			t.Fatalf("result status = %q, want %q", res.Status, want)
		}
	}
	if _, err := New(Config{Key: testKey, Envelope: "bogus"}); err == nil {
		t.Fatal("unknown envelope must be rejected")
	}
}

func TestConflictOnChangedBody(t *testing.T) {
	e := newEnv(t, "")
	applyChain(t, e)
	docsBefore, balBefore := e.docCount(), fmt.Sprint(e.balances())
	changed := mutate(t, fixture(t, "doc_sale.json"), func(m map[string]any) {
		m["lines"].([]any)[0].(map[string]any)["qty"] = -2
	})
	rec := e.post(changed)
	expectStatus(t, rec, http.StatusConflict)
	if decode(t, rec).Code != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if e.docCount() != docsBefore || fmt.Sprint(e.balances()) != balBefore {
		t.Fatal("conflict changed state")
	}
}

func TestIdempotencyKeyRules(t *testing.T) {
	e := newEnv(t, "")
	body := fixture(t, "doc_opening.json")
	expectValidation(t, e.postKey(body, ""))
	expectValidation(t, e.postKey(body, uid(1)))
	if e.docCount() != 0 {
		t.Fatal("rejected request stored a document")
	}
}

func TestInvalidLastLineWritesNothing(t *testing.T) {
	e := newEnv(t, "")
	bad := docBody(1, "adjust", ln(1, "FG-001", 1), ln(2, "FG-002", 1), ln(3, "FG-NOPE", 1))
	r := expectValidation(t, e.post(mustJSON(t, bad)))
	if r.Details[0].Path != "lines[2].fg_code" {
		t.Fatalf("details = %+v", r.Details)
	}
	if e.docCount() != 0 || len(e.balances()) != 0 {
		t.Fatal("invalid document wrote state")
	}
	fixed := docBody(2, "adjust", ln(1, "FG-001", 1)) // reuses line 0's movement id
	expectStatus(t, e.post(mustJSON(t, fixed)), http.StatusOK)
}

func TestLocationAndFGResolution(t *testing.T) {
	e := newEnv(t, "")
	cases := []struct {
		name string
		mod  func(m map[string]any)
		want int
	}{
		{"unknown location code", func(m map[string]any) { m["location"] = map[string]any{"type": "outlet", "code": "NOWHERE"} }, 422},
		{"tombstoned outlet code", func(m map[string]any) { m["location"] = map[string]any{"type": "outlet", "code": "POP"} }, 422},
		{"warehouse is never accepted", func(m map[string]any) { m["location"] = map[string]any{"type": "warehouse", "code": "KMG"} }, 422},
		{"tombstoned FG code is accepted (ERP BR7)", func(m map[string]any) { m["lines"] = []map[string]any{ln(1, "FG-006", 1)} }, 200},
		{"unknown FG code", func(m map[string]any) { m["lines"] = []map[string]any{ln(3, "FG-NOPE", 1)} }, 422},
		{"discontinued FG is accepted", func(m map[string]any) { m["lines"] = []map[string]any{ln(2, "FG-005", 1)} }, 200},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := docBody(10+i, "adjust", ln(100+i, "FG-001", 1))
			c.mod(d)
			rec := e.post(mustJSON(t, d))
			expectStatus(t, rec, c.want)
		})
	}
}

func TestDuplicateMovementIDs(t *testing.T) {
	e := newEnv(t, "")
	within := docBody(1, "adjust", ln(1, "FG-001", 1), ln(1, "FG-002", 1))
	expectValidation(t, e.post(mustJSON(t, within)))

	expectStatus(t, e.post(mustJSON(t, docBody(2, "adjust", ln(5, "FG-001", 1)))), http.StatusOK)
	other := docBody(3, "adjust", ln(5, "FG-001", 1))
	r := expectValidation(t, e.post(mustJSON(t, other)))
	if r.Details[0].Path != "lines[0].movement_id" {
		t.Fatalf("details = %+v", r.Details)
	}
}

func TestLineLimits(t *testing.T) {
	e := newEnv(t, "")
	mk := func(n, count int) []byte {
		lines := make([]map[string]any, 0, count)
		for i := 0; i < count; i++ {
			lines = append(lines, ln(n*1000+i, "FG-001", 1))
		}
		return mustJSON(t, docBody(n, "receipt", lines...))
	}
	expectStatus(t, e.post(mk(1, 200)), http.StatusOK)
	if e.qty("outlet", "KMG", "FG-001") != 200 {
		t.Fatalf("qty = %d", e.qty("outlet", "KMG", "FG-001"))
	}
	r := expectValidation(t, e.post(mk(2, 201)))
	if r.Details[0].Path != "lines" {
		t.Fatalf("details = %+v", r.Details)
	}
}

func TestTendersQtyAndKindValidation(t *testing.T) {
	e := newEnv(t, "")
	t.Run("tenders on count", func(t *testing.T) {
		d := docBody(1, "count", ln(1, "FG-001", 1))
		d["tenders"] = []map[string]any{{"method": "cash", "amount": 1}}
		expectValidation(t, e.post(mustJSON(t, d)))
	})
	t.Run("tender method crypto", func(t *testing.T) {
		d := docBody(2, "sale", ln(2, "FG-001", -1))
		d["tenders"] = []map[string]any{{"method": "crypto", "amount": 1}}
		expectValidation(t, e.post(mustJSON(t, d)))
	})
	t.Run("fractional qty", func(t *testing.T) {
		d := docBody(3, "adjust", ln(3, "FG-001", 1.5))
		expectValidation(t, e.post(mustJSON(t, d)))
	})
	t.Run("bad kind", func(t *testing.T) {
		expectValidation(t, e.post(mustJSON(t, docBody(4, "bogus", ln(4, "FG-001", 1)))))
	})
	if e.docCount() != 0 {
		t.Fatal("invalid documents stored")
	}
}

func TestPartValidation(t *testing.T) {
	e := newEnv(t, "")
	ok := docBody(1, "adjust", ln(1, "FG-001", 1))
	ok["part"] = map[string]any{"index": 2, "count": 3}
	expectStatus(t, e.post(mustJSON(t, ok)), http.StatusOK)
	bad := docBody(2, "adjust", ln(2, "FG-001", 1))
	bad["part"] = map[string]any{"index": 4, "count": 3}
	expectValidation(t, e.post(mustJSON(t, bad)))
}

func TestAuthRequiredEverywhere(t *testing.T) {
	e := newEnv(t, "")
	body := fixture(t, "doc_opening.json")
	targets := []struct{ method, path string }{
		{"POST", "/api/integration/v1/stock-documents"},
		{"GET", "/api/integration/v1/catalog/finished-goods"},
		{"GET", "/_stub/documents"},
		{"POST", "/_stub/fault?status=503&count=1"},
	}
	for _, tg := range targets {
		for name, hdr := range map[string]map[string]string{
			"missing": {},
			"wrong":   {"Authorization": "Bearer nope"},
		} {
			rec := e.do(tg.method, tg.path, body, hdr)
			if rec.Code != http.StatusUnauthorized || decode(t, rec).Code != "INTEGRATION_UNAUTHORIZED" {
				t.Fatalf("%s %s (%s): %d %s", tg.method, tg.path, name, rec.Code, rec.Body.String())
			}
		}
	}
}

func TestFaultInjection(t *testing.T) {
	e := newEnv(t, "")
	body := fixture(t, "doc_sale.json")
	expectStatus(t, e.postHook("/_stub/fault?status=503&count=2", nil), http.StatusOK)
	for i := 0; i < 2; i++ {
		rec := e.post(body)
		expectStatus(t, rec, http.StatusServiceUnavailable)
		if rec.Header().Get("Retry-After") != "1" || decode(t, rec).Code != "INTEGRATION_BUSY" {
			t.Fatalf("fault response: %v %s", rec.Header(), rec.Body.String())
		}
	}
	if e.docCount() != 0 {
		t.Fatal("faulted request wrote state")
	}
	expectStatus(t, e.post(body), http.StatusOK)

	expectStatus(t, e.postHook("/_stub/fault?status=429&count=1", nil), http.StatusOK)
	rec := e.get("/api/integration/v1/catalog/outlets")
	expectStatus(t, rec, http.StatusTooManyRequests)
	if decode(t, rec).Code != "RATE_LIMIT_EXCEEDED" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	for _, q := range []string{"status=200&count=1", "status=abc", "status=503&count=1001"} {
		expectValidation(t, e.postHook("/_stub/fault?"+q, nil))
	}
}

func TestConcurrentIdenticalPosts(t *testing.T) {
	e := newEnv(t, "")
	body := fixture(t, "doc_sale.json")
	const n = 20
	results := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := e.post(body)
			var res docResult
			var r resp
			_ = json.Unmarshal(rec.Body.Bytes(), &r)
			_ = json.Unmarshal(r.Data, &res)
			results <- fmt.Sprintf("%d/%s", rec.Code, res.Status)
		}()
	}
	wg.Wait()
	close(results)
	counts := map[string]int{}
	for r := range results {
		counts[r]++
	}
	if counts["200/applied"] != 1 || counts["200/replayed"] != n-1 {
		t.Fatalf("results = %v", counts)
	}
	if got := e.qty("outlet", "KMG", "FG-001"); got != -1 {
		t.Fatalf("balance moved %d, want -1 once", got)
	}
}

func TestStatePersistenceSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	e1 := newEnv(t, path)
	expectStatus(t, e1.post(fixture(t, "doc_opening.json")), http.StatusOK)
	sale := fixture(t, "doc_sale.json")
	expectStatus(t, e1.post(sale), http.StatusOK)

	e2 := newEnv(t, path)
	rec := e2.post(sale)
	expectStatus(t, rec, http.StatusOK)
	if decodeResult(t, rec).Status != "replayed" {
		t.Fatalf("restart replay = %s", rec.Body.String())
	}
	changed := mutate(t, sale, func(m map[string]any) { m["lines"].([]any)[0].(map[string]any)["qty"] = -5 })
	expectStatus(t, e2.post(changed), http.StatusConflict)
	if got := e2.qty("outlet", "KMG", "FG-001"); got != 41 {
		t.Fatalf("balance after restart = %d, want 41", got)
	}
	if e2.docCount() != 2 {
		t.Fatalf("documents after restart = %d", e2.docCount())
	}
}

func TestPersistFailureRollsBackAndNeverAnswersApplied(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, filepath.Join(dir, "state.json"))
	expectStatus(t, e.post(fixture(t, "doc_opening.json")), http.StatusOK)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	sale := fixture(t, "doc_sale.json")
	rec := e.post(sale)
	expectStatus(t, rec, http.StatusServiceUnavailable)
	if decode(t, rec).Code != "INTEGRATION_BUSY" {
		t.Fatalf("persist failure body = %s", rec.Body.String())
	}
	if e.docCount() != 1 || e.qty("outlet", "KMG", "FG-001") != 42 {
		t.Fatalf("rollback failed: docs=%d qty=%d", e.docCount(), e.qty("outlet", "KMG", "FG-001"))
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rec = e.post(sale)
	expectStatus(t, rec, http.StatusOK)
	if decodeResult(t, rec).Status != "applied" {
		t.Fatalf("retry after recovery = %s, want applied", rec.Body.String())
	}
}

func TestDocumentIDCaseChangeReplays(t *testing.T) {
	e := newEnv(t, "")
	expectStatus(t, e.post(fixture(t, "doc_opening.json")), http.StatusOK)
	sale := fixture(t, "doc_sale.json")
	expectStatus(t, e.post(sale), http.StatusOK)
	upper := mutate(t, sale, func(m map[string]any) { m["document_id"] = strings.ToUpper(m["document_id"].(string)) })
	rec := e.post(upper)
	expectStatus(t, rec, http.StatusOK)
	if decodeResult(t, rec).Status != "replayed" {
		t.Fatalf("id case change must replay: %s", rec.Body.String())
	}
}
