package erpstub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const outletsPostPath = "/api/integration/v1/outlets"

func (e *env) postOutlet(key, body string) *httptest.ResponseRecorder {
	h := map[string]string{"Authorization": "Bearer " + testKey}
	if key != "" {
		h["Idempotency-Key"] = key
	}
	return e.do(http.MethodPost, outletsPostPath, []byte(body), h)
}

func TestPostOutletCreatesThenReplaysAndConflicts(t *testing.T) {
	e := newEnv(t, "")
	body := `{"external_id":"k1","code":"GANCIT","name":"Gancit","type":"RETAIL"}`
	rec := e.postOutlet("k1", body)
	expectStatus(t, rec, http.StatusCreated)
	if !strings.Contains(rec.Body.String(), `"slug":"gancit"`) || !strings.Contains(rec.Body.String(), `"applied"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	p := getPage(t, e, "/api/integration/v1/catalog/outlets")
	found := false
	for _, it := range p.Items {
		found = found || it.Code == "GANCIT"
	}
	if !found {
		t.Fatalf("GANCIT not in catalog: %v", slugsOf(p.Items))
	}
	if !strings.Contains(e.get("/api/integration/v1/catalog/outlets").Body.String(), `"type":"RETAIL"`) {
		t.Fatal("created outlet is not RETAIL")
	}

	rec = e.postOutlet("k1", body)
	expectStatus(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"replayed"`) || !strings.Contains(rec.Body.String(), `"slug":"gancit"`) {
		t.Fatalf("replay body = %s", rec.Body.String())
	}

	rec = e.postOutlet("k1", `{"external_id":"k1","code":"GANCIT","name":"Other","type":"RETAIL"}`)
	expectStatus(t, rec, http.StatusConflict)
	if decode(t, rec).Code != "CONFLICT" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPostOutletCodeTakenCaseInsensitive(t *testing.T) {
	e := newEnv(t, "")
	expectStatus(t, e.postOutlet("k1", `{"external_id":"k1","code":"GANCIT","name":"Gancit"}`), http.StatusCreated)
	rec := e.postOutlet("k2", `{"external_id":"k2","code":"gancit","name":"Again"}`)
	expectStatus(t, rec, http.StatusConflict)
	if !strings.Contains(rec.Body.String(), `"OUTLET_CODE_TAKEN"`) || !strings.Contains(rec.Body.String(), `"slug":"gancit"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPostOutletBadCodeIs422(t *testing.T) {
	e := newEnv(t, "")
	for _, code := range []string{"", "A", "bad code", "-X"} {
		rec := e.postOutlet("k1", `{"external_id":"k1","code":"`+code+`","name":"N"}`)
		expectStatus(t, rec, http.StatusUnprocessableEntity)
	}
}
