package erpstub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// jakartaNow is the fixed clock of the rule tests: 2026-10-26 10:00 in Jakarta.
func jakartaNow() time.Time { return time.Date(2026, 10, 26, 10, 0, 0, 0, wib) }

func newRuleEnv(t *testing.T, assigned []string) *env {
	t.Helper()
	clock := &testClock{t: jakartaNow()}
	s, err := New(Config{Key: testKey, Now: clock.Now, AssignedOutlets: assigned})
	if err != nil {
		t.Fatal(err)
	}
	return &env{t: t, s: s, clock: clock}
}

func raw(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func occurredDoc(n int, kind, occurredAt string, lines ...map[string]any) []byte {
	d := docBody(n, kind, lines...)
	d["occurred_at"] = occurredAt
	return raw(d)
}

func withLocation(d map[string]any, loc map[string]any) []byte {
	d["location"] = loc
	return raw(d)
}

func wantOneIssue(t *testing.T, r resp, path string) {
	t.Helper()
	if len(r.Details) != 1 || r.Details[0].Path != path {
		t.Fatalf("details = %+v, want exactly one at %s", r.Details, path)
	}
}

func TestSlugAliasAcceptedWithWarning(t *testing.T) {
	e := newRuleEnv(t, nil)
	d := docBody(1, "adjust", ln(1, "FG-001", 1))
	rec := e.post(withLocation(d, map[string]any{"type": "outlet", "slug": "kemang"}))
	expectStatus(t, rec, http.StatusOK)
	if w := rec.Header().Get("Warning"); w != `299 - "location.slug is deprecated; send location.code"` {
		t.Fatalf("Warning = %q", w)
	}
	if e.qty("outlet", "KMG", "FG-001") != 1 {
		t.Fatal("alias did not resolve to KMG")
	}
}

func TestCodeWinsOverSlug(t *testing.T) {
	e := newRuleEnv(t, nil)
	d := docBody(1, "adjust", ln(1, "FG-001", 1))
	rec := e.post(withLocation(d, map[string]any{"type": "outlet", "code": "BSD", "slug": "kemang"}))
	expectStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Warning") != "" {
		t.Fatal("no warning expected when code is sent")
	}
	if e.qty("outlet", "BSD", "FG-001") != 1 || e.qty("outlet", "KMG", "FG-001") != 0 {
		t.Fatalf("balances = %+v", e.balances())
	}
}

func TestWarehouseTypeIsSchemaIssue(t *testing.T) {
	e := newRuleEnv(t, nil)
	d := docBody(1, "adjust", ln(1, "FG-001", 1))
	r := expectValidation(t, e.post(withLocation(d, map[string]any{"type": "warehouse", "code": "KMG"})))
	wantOneIssue(t, r, "location.type")
}

func TestUnassignedOutletIsLocationOnlyIssue(t *testing.T) {
	e := newRuleEnv(t, []string{"KMG"})
	// BSD is live but not assigned; the lines are bad too (sign, fg_code), yet only the outlet issue shows.
	d := docBody(1, "sale", ln(1, "FG-NOPE", 5))
	r := expectValidation(t, e.post(withLocation(d, map[string]any{"type": "outlet", "code": "BSD"})))
	wantOneIssue(t, r, "location.code")
	if r.Details[0].Message != "Outlet tidak dikenal atau tidak diatur untuk client ini" {
		t.Fatalf("message = %q", r.Details[0].Message)
	}
	for i, code := range []string{"NOWHERE", "POP"} { // unknown, deleted
		d := docBody(2+i, "sale", ln(2+i, "FG-001", -1))
		wantOneIssue(t, expectValidation(t, e.post(withLocation(d, map[string]any{"type": "outlet", "code": code}))), "location.code")
	}
	expectStatus(t, e.post(raw(docBody(9, "adjust", ln(9, "FG-001", 1)))), http.StatusOK)
}

func TestAssignedOutletsHook(t *testing.T) {
	e := newRuleEnv(t, nil)
	post := func(n int, code string) *httptest.ResponseRecorder {
		return e.post(withLocation(docBody(n, "adjust", ln(n, "FG-001", 1)), map[string]any{"type": "outlet", "code": code}))
	}
	expectStatus(t, post(1, "BSD"), http.StatusOK)
	rec := e.postHook("/_stub/assigned-outlets", []byte(`{"codes":["KMG"]}`))
	expectStatus(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"codes":["KMG"]`) {
		t.Fatalf("hook answer = %s", rec.Body.String())
	}
	expectValidation(t, post(2, "BSD"))
	expectStatus(t, post(3, "KMG"), http.StatusOK)
	expectStatus(t, e.postHook("/_stub/assigned-outlets", []byte(`{"codes":null}`)), http.StatusOK)
	expectStatus(t, post(4, "BSD"), http.StatusOK)
	expectStatus(t, e.postHook("/_stub/assigned-outlets", []byte(`{"codes":[]}`)), http.StatusOK)
	expectValidation(t, post(5, "KMG"))
	expectValidation(t, e.postHook("/_stub/assigned-outlets", []byte(`{}`)))
}

func TestReplayStillAnsweredAfterOutletUnassigned(t *testing.T) {
	e := newRuleEnv(t, nil)
	body := raw(docBody(1, "adjust", ln(1, "FG-001", 1)))
	expectStatus(t, e.post(body), http.StatusOK)
	expectStatus(t, e.postHook("/_stub/assigned-outlets", []byte(`{"codes":[]}`)), http.StatusOK)
	rec := e.post(body)
	expectStatus(t, rec, http.StatusOK)
	if decodeResult(t, rec).Status != "replayed" {
		t.Fatalf("replay = %s", rec.Body.String())
	}
}

func TestSignByKind(t *testing.T) {
	cases := []struct {
		kind    string
		okQty   []int
		badQty  int // 0 means any sign is allowed
		wantMsg string
	}{
		{"sale", []int{-1, 0}, 1, "qty sale harus ≤ 0"},
		{"transfer_out", []int{-1, 0}, 1, "qty transfer_out harus ≤ 0"},
		{"write_off", []int{-1, 0}, 1, "qty write_off harus ≤ 0"},
		{"refund", []int{1, 0}, -1, "qty refund harus ≥ 0"},
		{"transfer_in", []int{1, 0}, -1, "qty transfer_in harus ≥ 0"},
		{"transfer_cancel", []int{1, 0}, -1, "qty transfer_cancel harus ≥ 0"},
		{"receipt", []int{1, 0}, -1, "qty receipt harus ≥ 0"},
		{"adjust", []int{1, -1, 0}, 0, ""},
		{"count", []int{1, -1, 0}, 0, ""},
		{"opening", []int{1, -1, 0}, 0, ""},
	}
	for i, c := range cases {
		t.Run(c.kind, func(t *testing.T) {
			e := newRuleEnv(t, nil)
			for j, q := range c.okQty {
				n := i*100 + j + 1
				expectStatus(t, e.post(raw(docBody(n, c.kind, ln(n, "FG-001", q)))), http.StatusOK)
			}
			if c.badQty == 0 {
				return
			}
			n := i*100 + 50
			r := expectValidation(t, e.post(raw(docBody(n, c.kind, ln(n, "FG-001", c.badQty), ln(n+1, "FG-001", 0), ln(n+2, "FG-001", c.badQty)))))
			if len(r.Details) != 2 || r.Details[0].Path != "lines[0].qty" || r.Details[1].Path != "lines[2].qty" || r.Details[0].Message != c.wantMsg {
				t.Fatalf("details = %+v", r.Details)
			}
		})
	}
}

func TestPeriodAheadLimit(t *testing.T) {
	e := newRuleEnv(t, nil)
	r := expectValidation(t, e.post(occurredDoc(1, "adjust", jakartaNow().Add(24*time.Hour+time.Second).Format(time.RFC3339), ln(1, "FG-001", 1))))
	wantOneIssue(t, r, "occurred_at")
	if r.Details[0].Message != "occurred_at lebih dari 24 jam ke depan" {
		t.Fatalf("message = %q", r.Details[0].Message)
	}
	// Month end: 23 h ahead is already November in Jakarta, but the period is the current month.
	e.clock.t = time.Date(2026, 10, 31, 12, 0, 0, 0, wib)
	rec := e.post(occurredDoc(2, "adjust", e.clock.Now().Add(23*time.Hour).Format(time.RFC3339), ln(2, "FG-001", 1)))
	expectStatus(t, rec, http.StatusOK)
	var docs []docRecord
	_ = json.Unmarshal(decode(t, e.get("/_stub/documents")).Data, &docs)
	if len(docs) != 1 || docs[0].PeriodMonth != "2026-10" {
		t.Fatalf("period = %+v", docs)
	}
}

func TestPeriodSixMonthBoundaryInJakarta(t *testing.T) {
	e := newRuleEnv(t, nil)
	// now = 2026-10-26 Jakarta, so the earliest month is April 2026.
	expectStatus(t, e.post(occurredDoc(1, "adjust", "2026-04-01T00:00:00+07:00", ln(1, "FG-001", 1))), http.StatusOK)
	r := expectValidation(t, e.post(occurredDoc(2, "adjust", "2026-03-31T23:59:59+07:00", ln(2, "FG-001", 1))))
	wantOneIssue(t, r, "occurred_at")
	if r.Details[0].Message != "occurred_at lebih lama dari 6 bulan" {
		t.Fatalf("message = %q", r.Details[0].Message)
	}
	// 2026-03-31T17:00Z is April 1 in Jakarta: accepted although it is March in UTC.
	expectStatus(t, e.post(occurredDoc(3, "adjust", "2026-03-31T17:00:00Z", ln(3, "FG-001", 1))), http.StatusOK)
}

func TestZeroQtyLineDoesNotReserveMovementID(t *testing.T) {
	e := newRuleEnv(t, nil)
	expectStatus(t, e.post(raw(docBody(1, "adjust", ln(7, "FG-001", 0)))), http.StatusOK)
	// The id of a zero line is free, and a zero line is not checked against used ids either.
	expectStatus(t, e.post(raw(docBody(2, "adjust", ln(7, "FG-001", 3)))), http.StatusOK)
	expectStatus(t, e.post(raw(docBody(3, "adjust", ln(7, "FG-001", 0)))), http.StatusOK)
	r := expectValidation(t, e.post(raw(docBody(4, "adjust", ln(7, "FG-001", 1)))))
	wantOneIssue(t, r, "lines[0].movement_id")
}

func TestIdempotencyKeyIsCaseInsensitive(t *testing.T) {
	e := newRuleEnv(t, nil)
	body := raw(docBody(1, "adjust", ln(1, "FG-001", 1)))
	expectStatus(t, e.postKey(body, strings.ToUpper(uid(1))), http.StatusOK)
}

func TestStageOrderStopsAtFirstFailingStage(t *testing.T) {
	e := newRuleEnv(t, nil)
	// sign error and unknown fg together: only the sign stage answers.
	wantOneIssue(t, expectValidation(t, e.post(raw(docBody(1, "sale", ln(1, "FG-NOPE", 5))))), "lines[0].qty")
	// bad period and unknown fg together: only the period answers.
	wantOneIssue(t, expectValidation(t, e.post(occurredDoc(2, "adjust", "2020-01-01T00:00:00Z", ln(2, "FG-NOPE", 1)))), "occurred_at")
}

func TestBodyOver512KBIs413(t *testing.T) {
	e := newRuleEnv(t, nil)
	d := docBody(1, "adjust", ln(1, "FG-001", 1))
	d["customer_ref"] = strings.Repeat("x", 513<<10)
	rec := e.post(raw(d))
	expectStatus(t, rec, http.StatusRequestEntityTooLarge)
	if decode(t, rec).Code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestBalancesKeyedByOutletCode(t *testing.T) {
	e := newRuleEnv(t, nil)
	expectStatus(t, e.post(raw(docBody(1, "adjust", ln(1, "FG-001", 4)))), http.StatusOK)
	rows := e.balances()
	if len(rows) != 1 || rows[0].LocationCode != "KMG" || rows[0].LocationSlug != "kemang" || rows[0].LocationType != "outlet" {
		t.Fatalf("balances = %+v", rows)
	}
	expectStatus(t, e.get("/api/integration/v1/outlets/KMG/stock"), http.StatusOK)
}
