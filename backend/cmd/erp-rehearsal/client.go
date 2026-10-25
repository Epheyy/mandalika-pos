package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// obj is a decoded JSON object; the helpers below dig through untyped JSON so the
// harness depends on wire shapes only, never on the backend's Go types.
type obj = map[string]any

func get(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

func str(v any, keys ...string) string {
	s, _ := get(v, keys...).(string)
	return s
}

func num(v any, keys ...string) int {
	f, _ := get(v, keys...).(float64)
	return int(f)
}

func list(v any, keys ...string) []obj {
	arr, _ := get(v, keys...).([]any)
	out := make([]obj, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// resp is one HTTP answer: status, decoded JSON (nil when not JSON) and the raw text.
type resp struct {
	Code int
	Body any
	Raw  string
}

func (r resp) ok() bool { return r.Code >= 200 && r.Code < 300 }

func (r resp) brief() string {
	s := strings.TrimSpace(r.Raw)
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return fmt.Sprintf("HTTP %d %s", r.Code, s)
}

type httpc struct {
	base string
	hc   *http.Client
	hdr  map[string]string
	// noCache appends a unique _= query parameter to every GET: the backend's Redis
	// read cache (15 s, key = path + query) is not dropped by every writer (the ERP
	// relay does not invalidate it), so a plain re-read can be stale.
	noCache bool
	// onRetry, when set, reports a transport retry (the runner adds the step name).
	onRetry func(msg string)
}

// Transport retry (2026-10-25): from the operator laptop about a third of connections to
// Cloud Run were dropped (reset, unexpected EOF, timeout) after the server had already
// answered. call retries such a transport-level failure up to len(retryBackoff) more
// times, waiting 2, 4, 8 and 16 s. It never retries after an HTTP response of any status,
// and only replays a request whose second arrival cannot apply twice (replaySafe).
var retryBackoff = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}

// idempotentPOSTs are the POST paths (relative to the client base, query ignored) that are
// safe to replay: login only opens another session; the relay and catalog-pull runs and
// the stub's FG/outlet upserts and fault switch converge on the same state; /sync/batch
// dedupes every order by its idempotencyKey. Not here, so sent exactly once: POST
// /products, /transfers, /transfers/{id}/receive (no key), /shifts, /shifts/{id}/close,
// /inventory/adjust, a goods receipt without an Idempotency-Key, the outbox retry, and
// every DELETE. A lost response on those fails the step instead of risking a second apply.
var idempotentPOSTs = map[string]bool{
	"/api/v1/auth/login": true, "/internal/erp/relay": true, "/internal/erp/catalog-pull": true,
	"/_stub/fg": true, "/_stub/outlet": true, "/_stub/fault": true, "/sync/batch": true,
}

// replaySafe: GET and PUT (full replacement), any request with an Idempotency-Key (the
// server answers a replay with the first result), and the idempotentPOSTs.
func replaySafe(method, path string, h map[string]string) bool {
	switch {
	case method == http.MethodGet, method == http.MethodPut:
		return true
	case h["Idempotency-Key"] != "":
		return true
	case method == http.MethodPost:
		return idempotentPOSTs[redactQuery(path)]
	}
	return false
}

func newHTTP(base string, hdr map[string]string) *httpc {
	return &httpc{base: strings.TrimRight(base, "/"), hc: &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}, hdr: hdr}
}

// call sends one request; h adds per-call headers; body (if non-nil) is sent as JSON.
// A transport failure is retried when replaySafe allows it (see retryBackoff).
func (c *httpc) call(method, path string, h map[string]string, body any) (resp, error) {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return resp{}, err
		}
		payload = b
	}
	retries := 0
	if replaySafe(method, path, h) {
		retries = len(retryBackoff)
	}
	for attempt := 0; ; attempt++ {
		out, err := c.once(method, path, h, payload)
		if err == nil || attempt >= retries {
			return out, err
		}
		if c.onRetry != nil {
			c.onRetry(fmt.Sprintf("transport retry %d/%d of %s %s in %v: %v",
				attempt+1, retries, method, redactQuery(path), retryBackoff[attempt], err))
		}
		time.Sleep(retryBackoff[attempt])
	}
}

// once sends one attempt. An error means no complete HTTP response (dial, reset, EOF,
// timeout, or a body cut off mid-read).
func (c *httpc) once(method, path string, h map[string]string, payload []byte) (resp, error) {
	var rd io.Reader
	if payload != nil {
		rd = bytes.NewReader(payload)
	}
	if c.noCache && method == http.MethodGet {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		path += fmt.Sprintf("%s_=%d", sep, time.Now().UnixNano())
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return resp{}, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.hdr {
		req.Header.Set(k, v)
	}
	for k, v := range h {
		req.Header.Set(k, v)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return resp{}, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return resp{}, err
	}
	out := resp{Code: res.StatusCode, Raw: string(raw)}
	var v any
	if json.Unmarshal(raw, &v) == nil {
		out.Body = v
	}
	return out, nil
}

// must is call + "2xx or error": the common shape for setup calls.
func (c *httpc) must(method, path string, h map[string]string, body any) (resp, error) {
	r, err := c.call(method, path, h, body)
	if err != nil {
		return r, fmt.Errorf("%s %s: %w", method, redactQuery(path), err)
	}
	if !r.ok() {
		return r, fmt.Errorf("%s %s: %s", method, redactQuery(path), r.brief())
	}
	return r, nil
}

func redactQuery(p string) string {
	if i := strings.Index(p, "?"); i >= 0 {
		return p[:i]
	}
	return p
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
