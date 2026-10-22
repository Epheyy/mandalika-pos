package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

const pgMessage = `invalid input syntax for type uuid: "not-a-uuid"`

var leakTokens = []string{"SQLSTATE", "ERROR:", "customers_phone_key", "invalid input syntax", "pgx", "pgconn"}

func assertNoLeak(t *testing.T, body string) {
	t.Helper()
	for _, tok := range leakTokens {
		if strings.Contains(body, tok) {
			t.Fatalf("response leaks %q: %s", tok, body)
		}
	}
}

func TestWriteErrClassification(t *testing.T) {
	pg := func(code, constraint string) error {
		return &pgconn.PgError{Code: code, Message: pgMessage, ConstraintName: constraint}
	}
	tests := []struct {
		name       string
		status     int
		err        error
		wantStatus int
		wantBody   string // substring; "" = skip
	}{
		{"bad uuid read path", 500, pg("22P02", ""), 400, "invalid input"},
		{"unique violation wrapped", 400, fmt.Errorf("create customer: %w", pg("23505", "customers_phone_key")), 400, "the change conflicts with existing data"},
		{"unique violation on 500 path is a server fault", 500, pg("23505", "customers_phone_key"), 500, "internal error"},
		{"division by zero on 500 path", 500, pg("22012", ""), 500, "internal error"},
		{"numeric overflow on 500 path", 500, pg("22003", ""), 500, "internal error"},
		{"bad date on 500 path", 500, pg("22007", ""), 400, "invalid input"},
		{"bad timestamp on 500 path", 500, pg("22008", ""), 400, "invalid input"},
		{"data exception on 4xx path", 400, pg("22012", ""), 400, "invalid input"},
		{"sku named pgx-1 stays domain text", 400, errors.New("SKU sudah dipakai produk lain: pgx-1"), 400, "pgx-1"},
		{"deadlock", 500, pg("40P01", ""), 409, write.ErrBusy.Error()},
		{"serialization", 400, pg("40001", ""), 409, write.ErrBusy.Error()},
		{"lock not available", 500, pg("55P03", ""), 409, write.ErrBusy.Error()},
		{"undefined table", 400, pg("42P01", ""), 500, "internal error"},
		{"deadline", 400, fmt.Errorf("x: %w", context.DeadlineExceeded), 500, "internal error"},
		{"canceled", 500, context.Canceled, 500, "internal error"},
		{"no rows", 500, pgx.ErrNoRows, 404, "not found"},
		{"read not found", 500, fmt.Errorf("a: %w", read.ErrNotFound), 404, "not found"},
		{"write not found", 400, write.ErrNotFound, 404, "not found"},
		{"domain text kept", 400, errors.New("nama wajib diisi"), 400, "nama wajib diisi"},
		{"domain 409 kept", 409, errors.New("sudah ada"), 409, "sudah ada"},
		{"plain 500 generic", 500, errors.New("boom secret detail"), 500, "internal error"},
		{"%v-wrapped db text", 400, fmt.Errorf("create failed: %v", errors.New("ERROR: relation x (SQLSTATE 42P01)")), 500, "internal error"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/x", nil)
			writeErr(w, r, tc.status, tc.err)
			if w.Code != tc.wantStatus {
				t.Fatalf("status %d want %d body %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantBody != "" && !strings.Contains(w.Body.String(), tc.wantBody) {
				t.Fatalf("body %s lacks %q", w.Body.String(), tc.wantBody)
			}
			if !strings.Contains(tc.name, "domain text") && !strings.Contains(tc.name, "pgx-1") {
				assertNoLeak(t, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "boom secret detail") {
				t.Fatalf("raw error leaked: %s", w.Body.String())
			}
		})
	}
}

func TestGeneric500CarriesRequestID(t *testing.T) {
	var got string
	h := chimw.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = chimw.GetReqID(r.Context())
		writeErr(w, r, 500, errors.New("boom"))
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if got == "" || !strings.Contains(w.Body.String(), "internal error (ref "+got+")") {
		t.Fatalf("request id %q not in body %s", got, w.Body.String())
	}
}

func TestMutatedAndCreatedSanitise(t *testing.T) {
	h := &Handlers{}
	pgDup := fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505", Message: pgMessage, ConstraintName: "customers_phone_key"})
	cases := []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"pg unique", pgDup, 400, "the change conflicts with existing data"},
		{"pg bad uuid", &pgconn.PgError{Code: "22P02", Message: pgMessage}, 400, "invalid input"},
		{"pg other", &pgconn.PgError{Code: "42P01", Message: pgMessage}, 500, "internal error"},
		{"domain", errors.New("harga tidak valid"), 400, "harga tidak valid"},
		{"sku taken", &write.SkuTakenError{SKU: "ABC"}, 409, "SKU sudah dipakai produk lain: ABC"},
		{"not found", write.ErrNotFound, 404, "not found"},
		{"busy", write.ErrBusy, 409, write.ErrBusy.Error()},
		{"sku taken wrapping pg", fmt.Errorf("%w: %w", &write.SkuTakenError{SKU: "ABC"}, &pgconn.PgError{Code: "23505", Message: pgMessage, ConstraintName: "customers_phone_key"}), 409, ""},
	}
	for _, tc := range cases {
		for _, which := range []string{"mutated", "created"} {
			t.Run(which+"/"+tc.name, func(t *testing.T) {
				w := httptest.NewRecorder()
				r := httptest.NewRequest(http.MethodPost, "/x", nil)
				if which == "mutated" {
					h.mutated(w, r, tc.err)
				} else {
					h.created(w, r, "id", tc.err)
				}
				want := tc.status
				if which == "created" && tc.name == "busy" {
					want = http.StatusBadRequest // created() has no ErrBusy branch (unchanged); text stays domain-only
				}
				if w.Code != want {
					t.Fatalf("status %d want %d body %s", w.Code, want, w.Body.String())
				}
				if tc.body != "" && !strings.Contains(w.Body.String(), tc.body) {
					t.Fatalf("body %s lacks %q", w.Body.String(), tc.body)
				}
				assertNoLeak(t, w.Body.String())
			})
		}
	}
}
