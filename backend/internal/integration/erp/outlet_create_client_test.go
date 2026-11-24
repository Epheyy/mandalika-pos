package erp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const outletTestKey = "sekrit-key-123"

func outletServer(t *testing.T, status int, body string) (*OutletCreateClient, *http.Request, *[]byte) {
	t.Helper()
	var got http.Request
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r.Clone(context.Background())
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewOutletCreateClient(srv.URL+"/api/integration/v1", outletTestKey, 0), &got, &gotBody
}

var outletIn = OutletCreate{ExternalID: "11111111-2222-3333-4444-555555555555", Code: "GANCIT", Name: "Gancit"}

func TestOutletCreateRequestShape(t *testing.T) {
	c, req, body := outletServer(t, 201, `{"status":"success","data":{"status":"applied","outlet":{"slug":"gancit","code":"GANCIT"}}}`)
	res, out, detail, err := c.CreateOutlet(context.Background(), outletIn)
	if err != nil || out != OutletCreated || res.Slug != "gancit" || res.Code != "GANCIT" || res.Replayed || detail != "" {
		t.Fatalf("got %+v %v %q %v", res, out, detail, err)
	}
	if req.Method != http.MethodPost || req.URL.Path != "/api/integration/v1/outlets" {
		t.Fatalf("request = %s %s", req.Method, req.URL.Path)
	}
	if req.Header.Get("Idempotency-Key") != outletIn.ExternalID || req.Header.Get("Authorization") != "Bearer "+outletTestKey {
		t.Fatalf("headers = %v", req.Header)
	}
	var m map[string]any
	if err := json.Unmarshal(*body, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != "RETAIL" || m["external_id"] != outletIn.ExternalID || m["code"] != "GANCIT" || m["name"] != "Gancit" {
		t.Fatalf("body = %s", *body)
	}
}

func TestOutletCreateOutcomes(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		want       OutletCreateOutcome
		wantDetail string
		replayed   bool
		slug       string
	}{
		{"replayed legacy envelope", 200, `{"success":true,"data":{"status":"replayed","slug":"gancit","code":"GANCIT"}}`, OutletCreated, "", true, "gancit"},
		{"success without slug", 201, `{"status":"success","data":{"status":"applied"}}`, OutletRejected, "slug", false, ""},
		{"code taken", 409, `{"code":"OUTLET_CODE_TAKEN","details":{"slug":"x"}}`, OutletCodeTaken, "x", false, ""},
		{"code taken no details", 409, `{"code":"OUTLET_CODE_TAKEN"}`, OutletCodeTaken, "unknown", false, ""},
		{"conflict", 409, `{"code":"CONFLICT","message":"different body"}`, OutletRejected, "CONFLICT", false, ""},
		{"validation", 422, `{"code":"VALIDATION_ERROR","message":"bad"}`, OutletRejected, "VALIDATION_ERROR", false, ""},
		{"unauthorized", 401, `{"code":"INTEGRATION_UNAUTHORIZED"}`, OutletRejected, "401", false, ""},
		{"404", 404, ``, OutletEndpointMissing, "404", false, ""},
		{"405", 405, ``, OutletEndpointMissing, "405", false, ""},
		{"503", 503, `{"code":"INTEGRATION_BUSY"}`, OutletUnavailable, "503", false, ""},
		{"2xx garbage", 200, `<html>`, OutletRejected, "unexpected", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, _ := outletServer(t, tc.status, tc.body)
			res, out, detail, err := c.CreateOutlet(context.Background(), outletIn)
			if err != nil || out != tc.want || res.Replayed != tc.replayed || res.Slug != tc.slug {
				t.Fatalf("got %+v %v %q %v", res, out, detail, err)
			}
			if !strings.Contains(detail, tc.wantDetail) {
				t.Fatalf("detail %q lacks %q", detail, tc.wantDetail)
			}
		})
	}
}

func TestOutletCreateTimeoutIsUnavailableAndScrubbed(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	c := NewOutletCreateClient(srv.URL, outletTestKey, 50*time.Millisecond)
	_, out, detail, err := c.CreateOutlet(context.Background(), outletIn)
	if err != nil || out != OutletUnavailable || detail == "" || strings.Contains(detail, outletTestKey) {
		t.Fatalf("got %v %q %v", out, detail, err)
	}
}

func TestOutletCreateCancelledContextIsError(t *testing.T) {
	c, _, _ := outletServer(t, 201, `{}`)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := c.CreateOutlet(ctx, outletIn); err == nil {
		t.Fatal("want ctx error")
	}
}

func TestOutletCreateKeyNeverLeaks(t *testing.T) {
	c, _, _ := outletServer(t, 422, `{"message":"bad key `+outletTestKey+`"}`)
	_, _, detail, _ := c.CreateOutlet(context.Background(), outletIn)
	if strings.Contains(detail, outletTestKey) {
		t.Fatalf("detail leaks key: %q", detail)
	}
}
