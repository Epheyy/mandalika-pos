package erp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var testCfg = Config{MaxAttempts: 10, AuthBackoff: 5 * time.Minute}

const (
	appliedBody  = `{"success":true,"data":{"document_id":"d1","status":"applied","movement_ids":["m1"]}}`
	replayedBody = `{"success":true,"data":{"document_id":"d1","status":"replayed","movement_ids":["m1"]}}`
)

func errBody(code, msg string) []byte {
	return []byte(`{"success":false,"error":"x","message":"` + msg + `","code":"` + code + `","requestId":"r1"}`)
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name       string
		resp       Response
		err        error
		attempts   int
		status     string
		wantStop   string
		wantAtt    int
		minDelay   time.Duration
		errContain string
	}{
		{name: "200 applied", resp: Response{Status: 200, Body: []byte(appliedBody)}, status: statusDelivered, wantAtt: 1},
		{name: "200 replayed", resp: Response{Status: 200, Body: []byte(replayedBody)}, status: statusReplayed, wantAtt: 1},
		{name: "200 unexpected body retries", resp: Response{Status: 200, Body: []byte("ok")}, status: statusPending, wantAtt: 1,
			minDelay: 2 * time.Minute, errContain: "unexpected 2xx body"},
		{name: "200 other document", resp: Response{Status: 200, Body: []byte(`{"success":true,"data":{"document_id":"zz","status":"applied"}}`)},
			status: statusPending, wantAtt: 1, errContain: "unexpected 2xx body"},
		{name: "200 success false", resp: Response{Status: 200, Body: []byte(`{"success":false,"data":{"document_id":"d1","status":"applied"}}`)},
			status: statusPending, wantAtt: 1, errContain: "unexpected 2xx body"},
		{name: "200 unknown status", resp: Response{Status: 200, Body: []byte(`{"success":true,"data":{"document_id":"d1","status":"queued"}}`)},
			status: statusPending, wantAtt: 1, errContain: "unexpected 2xx body"},
		{name: "200 document id case-insensitive", resp: Response{Status: 200, Body: []byte(`{"success":true,"data":{"document_id":"D1","status":"applied"}}`)},
			status: statusDelivered, wantAtt: 1},
		{name: "400", resp: Response{Status: 400, Body: errBody("BAD", "bad json")}, status: statusDead, wantAtt: 1, errContain: "BAD: bad json"},
		{name: "401", resp: Response{Status: 401, Body: errBody("UNAUTHORIZED", "no key")}, attempts: 3, status: statusPending,
			wantStop: stopUnauthorized, wantAtt: 3, minDelay: 5 * time.Minute, errContain: "UNAUTHORIZED: no key"},
		{name: "403", resp: Response{Status: 403, Body: errBody("FORBIDDEN", "suspended")}, attempts: 3, status: statusPending,
			wantStop: stopForbidden, wantAtt: 3, minDelay: 5 * time.Minute},
		{name: "409 names sha", resp: Response{Status: 409, Body: errBody("IDEMPOTENCY_CONFLICT", "different body")}, status: statusDead,
			wantAtt: 1, errContain: "payload_sha256=abc123"},
		{name: "422", resp: Response{Status: 422, Body: errBody("UNKNOWN_FG", "fg_code FG-9")}, status: statusDead, wantAtt: 1, errContain: "UNKNOWN_FG"},
		{name: "429 with Retry-After keeps attempts", resp: Response{Status: 429, RetryAfter: 120 * time.Second}, attempts: 4, status: statusPending,
			wantStop: stopRateLimited, wantAtt: 4, minDelay: 120 * time.Second},
		{name: "429 without Retry-After pauses a minute", resp: Response{Status: 429}, attempts: 9, status: statusPending,
			wantStop: stopRateLimited, wantAtt: 9, minDelay: time.Minute},
		{name: "500", resp: Response{Status: 500}, status: statusPending, wantAtt: 1, minDelay: 2 * time.Minute, errContain: "HTTP 500"},
		{name: "502", resp: Response{Status: 502}, status: statusPending, wantAtt: 1, minDelay: 2 * time.Minute},
		{name: "503", resp: Response{Status: 503}, attempts: 2, status: statusPending, wantAtt: 3, minDelay: 8 * time.Minute},
		{name: "404", resp: Response{Status: 404}, status: statusPending, wantAtt: 1, minDelay: 2 * time.Minute},
		{name: "network error", err: errors.New("dial tcp: refused"), status: statusPending, wantAtt: 1,
			minDelay: 2 * time.Minute, errContain: "refused"},
		{name: "attempt 10 of 10 on 503 dies", resp: Response{Status: 503}, attempts: 9, status: statusDead, wantAtt: 10,
			errContain: "max attempts reached"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := classify(c.resp, c.err, c.attempts, "abc123", "d1", testCfg)
			if o.status != c.status || o.stop != c.wantStop || o.attempts != c.wantAtt {
				t.Errorf("got status=%s stop=%q attempts=%d; want %s %q %d", o.status, o.stop, o.attempts, c.status, c.wantStop, c.wantAtt)
			}
			if o.delay < c.minDelay {
				t.Errorf("delay = %v, want >= %v", o.delay, c.minDelay)
			}
			if !strings.Contains(o.lastError, c.errContain) {
				t.Errorf("lastError = %q, want substring %q", o.lastError, c.errContain)
			}
			if c.err != nil && o.httpStatus != nil {
				t.Error("network error must leave last_http_status NULL")
			}
		})
	}
}

func TestClassifyConflictMessageSaysErpHoldsDifferentBody(t *testing.T) {
	o := classify(Response{Status: 409, Body: errBody("C", "m")}, nil, 0, "sha", "d1", testCfg)
	if !strings.Contains(o.lastError, "already holds a different body") {
		t.Errorf("lastError = %q", o.lastError)
	}
}

func TestClassifyStoresNonJSONBodyWrapped(t *testing.T) {
	o := classify(Response{Status: 502, Body: []byte("<html>bad gateway</html>")}, nil, 0, "", "d1", testCfg)
	if o.response == nil || !strings.HasPrefix(*o.response, `{"raw":`) {
		t.Errorf("response = %v", o.response)
	}
}

func TestBackoffSequence(t *testing.T) {
	want := []int{2, 4, 8, 16, 32, 60, 60, 60}
	for i, mins := range want {
		if got := backoff(i + 1); got != time.Duration(mins)*time.Minute {
			t.Errorf("backoff(%d) = %v, want %dm", i+1, got, mins)
		}
	}
}

func TestRetryAfterBeatsShorterBackoff(t *testing.T) {
	o := classify(Response{Status: 503, RetryAfter: 30 * time.Minute}, nil, 0, "", "d1", testCfg)
	if o.delay != 30*time.Minute {
		t.Errorf("delay = %v, want 30m", o.delay)
	}
}

func TestTruncateKeepsValidUTF8(t *testing.T) {
	s := strings.Repeat("é", 400) // 2 bytes each
	if got := truncate(s, 501); !utf8.ValidString(got) || len(got) > 501 {
		t.Errorf("invalid or too long: %d bytes", len(got))
	}
}

// ERP answers a fake server with each class; Client and classify must agree.
func TestClientAndClassifyAgainstFakeServer(t *testing.T) {
	cases := []struct {
		status int
		header string
		body   string
		want   string
	}{
		{200, "", appliedBody, statusDelivered},
		{200, "", replayedBody, statusReplayed},
		{400, "", string(errBody("BAD", "m")), statusDead},
		{409, "", string(errBody("C", "m")), statusDead},
		{422, "", string(errBody("U", "m")), statusDead},
		{401, "", string(errBody("A", "m")), statusPending},
		{429, "90", "", statusPending},
		{503, "", "", statusPending},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if c.header != "" {
				w.Header().Set("Retry-After", c.header)
			}
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		}))
		resp, err := NewStockDocClient(srv.URL, "k", 0).PostStockDocument(context.Background(), "d1", []byte(`{}`))
		srv.Close()
		if err != nil {
			t.Fatalf("%d: %v", c.status, err)
		}
		o := classify(resp, nil, 0, "sha", "d1", testCfg)
		if o.status != c.want {
			t.Errorf("HTTP %d: status = %s, want %s", c.status, o.status, c.want)
		}
		if c.status == 429 && (o.stop != stopRateLimited || o.delay < 90*time.Second) {
			t.Errorf("429: stop=%q delay=%v", o.stop, o.delay)
		}
	}
}

func TestOutcomeCount(t *testing.T) {
	var rep RunReport
	for _, o := range []outcome{
		{status: statusDelivered}, {status: statusReplayed}, {status: statusDead},
		{status: statusPending}, {status: statusPending, stop: stopRateLimited},
		{status: statusPending, stop: stopUnauthorized},
	} {
		o.count(&rep)
	}
	want := RunReport{Delivered: 1, Replayed: 1, Dead: 1, Retried: 1, Released: 2}
	if rep != want {
		t.Errorf("report = %+v, want %+v", rep, want)
	}
}

func TestRunDisabledDoesNothing(t *testing.T) {
	r := NewRelay(nil, nil, Config{Enabled: false}, nil)
	rep, err := r.Run(context.Background())
	if err != nil || !rep.Disabled || rep.Claimed != 0 {
		t.Errorf("rep=%+v err=%v", rep, err)
	}
}

func TestNewRelayExtendsShortLease(t *testing.T) {
	r := NewRelay(nil, nil, Config{Budget: 40 * time.Second, Lease: 50 * time.Second}, nil)
	if r.cfg.Lease != 85*time.Second {
		t.Errorf("lease = %v, want 85s", r.cfg.Lease)
	}
	r = NewRelay(nil, nil, Config{Budget: 20 * time.Second, Lease: 60 * time.Second}, nil)
	if r.cfg.Lease != 60*time.Second {
		t.Errorf("sufficient lease changed to %v", r.cfg.Lease)
	}
}

// Postgres rejects invalid UTF-8, NUL and lone surrogates in jsonb/text; none may survive.
func TestClassifySanitisesHostileBodies(t *testing.T) {
	bodies := map[string]string{
		"json nul escape": `{"success":false,"message":"a\u0000b","code":"X\u0000"}`,
		"lone surrogate":  `{"success":false,"message":"a\ud800b","code":"C"}`,
		"invalid utf8":    "{\"success\":false,\"message\":\"a\xffb\",\"code\":\"C\"}",
		"raw nul byte":    "{\"message\":\"a\x00b\"}",
		"non-json":        "bad\x00 gate\xfeway \xed\xa0\x80",
		"array":           `["a\u0000"]`,
	}
	for name, b := range bodies {
		for _, status := range []int{200, 422, 502} {
			o := classify(Response{Status: status, Body: []byte(b)}, nil, 0, "", "d1", testCfg)
			for field, v := range map[string]string{"lastError": o.lastError, "response": deref(o.response)} {
				if !utf8.ValidString(v) || strings.ContainsRune(v, 0) || (!strings.HasPrefix(v, `{"raw"`) && (strings.Contains(v, `\u0000`) || strings.Contains(v, `\ud800`))) {
					t.Errorf("%s/%d: %s not storable: %q", name, status, field, v)
				}
			}
			if o.response == nil || !strings.HasPrefix(*o.response, "{") {
				t.Errorf("%s/%d: response must be a JSON object, got %v", name, status, o.response)
			}
		}
	}
	o := classify(Response{}, errors.New("dial \xff\x00 refused"), 0, "", "d1", testCfg)
	if !utf8.ValidString(o.lastError) || strings.ContainsRune(o.lastError, 0) {
		t.Errorf("network error text not cleaned: %q", o.lastError)
	}
}

func TestCleanedObjectKeepsStructure(t *testing.T) {
	got := deref(rawJSON([]byte(`{"a":{"b":[1,2.50,"x\u0000y"]},"n":12345678901234567890}`)))
	if got != `{"a":{"b":[1,2.50,"xy"]},"n":12345678901234567890}` {
		t.Errorf("got %s", got)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func TestNewRelayDefaults(t *testing.T) {
	r := NewRelay(nil, nil, Config{}, nil)
	c := r.cfg
	if c.MaxAttempts != 10 || c.BatchSize != 50 || c.Budget != 20*time.Second || c.Lease != 60*time.Second ||
		c.HoldDelay != 5*time.Minute || c.AuthBackoff != 5*time.Minute {
		t.Errorf("defaults = %+v", c)
	}
}
