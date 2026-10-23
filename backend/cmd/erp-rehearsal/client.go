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
}

func newHTTP(base string, hdr map[string]string) *httpc {
	return &httpc{base: strings.TrimRight(base, "/"), hc: &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}, hdr: hdr}
}

// call sends one request; h adds per-call headers; body (if non-nil) is sent as JSON.
func (c *httpc) call(method, path string, h map[string]string, body any) (resp, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return resp{}, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return resp{}, err
	}
	if body != nil {
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
