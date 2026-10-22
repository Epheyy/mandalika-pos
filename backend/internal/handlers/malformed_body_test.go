package handlers

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/api"
)

// A43: a present-but-malformed body on these optional-body handlers is a 400 and
// reaches no mutation (the zero-value Handlers has no store/repo: touching one
// would panic), while an empty body stays a valid "no items / no guard" request.
func TestMalformedOptionalBodiesRejected(t *testing.T) {
	cases := []struct {
		name    string
		path    string
		pattern string
		bodies  []string
		handler func(h *Handlers) http.HandlerFunc
	}{
		{"complete stock count", "/stock-counts/sc1/complete", "/stock-counts/{id}/complete", []string{`{"items":`, `{"items":"x"}`, `[]`, `{}junk`, `junk`}, func(h *Handlers) http.HandlerFunc { return h.CompleteStockCount }},
		{"restore recipe version", "/p/p1/variants/v1/recipe/versions/ver1/restore", "/p/{productId}/variants/{variantId}/recipe/versions/{versionId}/restore", []string{`{"expectedCurrentVersionId":`, `{"expectedCurrentVersionId":5}`, `[]`, `{}junk`, `junk`}, func(h *Handlers) http.HandlerFunc { return h.RestoreRecipeVersion }},
	}
	for _, tc := range cases {
		for _, raw := range tc.bodies {
			t.Run(tc.name+" "+raw, func(t *testing.T) {
				router := chi.NewRouter()
				router.Post(tc.pattern, tc.handler(&Handlers{}))
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest("POST", tc.path, strings.NewReader(raw)))
				if w.Code != http.StatusBadRequest {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
			})
		}
	}
}

func TestDecodeOptionalBody(t *testing.T) {
	var v struct {
		Items []string `json:"items"`
	}
	for _, empty := range []string{"", "  \n"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(empty))
		if err := decodeOptionalBody(r, &v); err != nil {
			t.Fatalf("empty body %q must be tolerated: %v", empty, err)
		}
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"items":["a"]}`))
	if err := decodeOptionalBody(r, &v); err != nil || len(v.Items) != 1 {
		t.Fatalf("valid body: %v %+v", err, v)
	}
	for _, bad := range []string{`{`, `{"items":1}`, `{"items":[]} x`, `null x`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(bad))
		if err := decodeOptionalBody(r, &v); err == nil {
			t.Fatalf("malformed %q accepted", bad)
		}
	}
}

func TestShiftOrReceipt(t *testing.T) {
	receipt := api.Shift{CashierName: "receipt"}
	read := api.Shift{CashierName: "read"}
	if got := shiftOrReceipt(read, nil, receipt); got.CashierName != "read" {
		t.Fatalf("successful read-back must win: %+v", got)
	}
	if got := shiftOrReceipt(api.Shift{}, errors.New("db down"), receipt); got.CashierName != "receipt" {
		t.Fatalf("failed read-back must return the receipt, not a zero shift: %+v", got)
	}
}

func TestShiftReceiptFields(t *testing.T) {
	now := time.Now()
	open := openShiftReceipt("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "u1", "Kasir", "Outlet", 50, now)
	if open.Status != "open" || open.Id.String() != "11111111-1111-4111-8111-111111111111" || open.StartingCash != 50 || open.CashierName != "Kasir" {
		t.Fatalf("open receipt: %+v", open)
	}
	closed := closedShiftReceipt("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", 75, now)
	if closed.Status != "closed" || closed.Id.String() != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("closed receipt: %+v", closed)
	}
}

func TestDecodeOptionalBodyKeepsMaxBytesErrorOnTrailingInput(t *testing.T) {
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Body = http.MaxBytesReader(rec, io.NopCloser(strings.NewReader(`{"a":1}`+strings.Repeat(" ", 64)+`x`)), 16)
	var v struct{}
	err := decodeOptionalBody(r, &v)
	if !isBodyTooLarge(err) {
		t.Fatalf("err = %v, want a *http.MaxBytesError in the chain", err)
	}
}
