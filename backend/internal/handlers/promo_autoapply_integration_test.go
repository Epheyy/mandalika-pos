package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Promo auto-apply S1: promotions.auto_apply must survive the whole read/write path (create, list, sync pull,
// update). Driven through the real handlers; opt-in fresh synthetic cluster (port 26480, prefix AA).
func TestPromoAutoApplyPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "AA", 26480)
	const (
		outlet = "00000000-0000-4000-8f00-000000000001"
		adminU = "00000000-0000-4000-8f00-000000000011"
	)
	for _, q := range []string{
		`INSERT INTO outlets(id,name) VALUES('` + outlet + `','AA Outlet')`,
		`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES('` + adminU + `','aa-admin@example.invalid','x','AA Admin','admin',NULL)`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	rd, wr := read.New(pool), write.New(pool)
	h := New(rd, nil, nil, wr, nil, nil, nil)
	secret := []byte("AA-SYNTHETIC-TEST-KEY")
	tok, err := auth.IssueAccess(secret, time.Hour, adminU, "admin", "", []string{"manage_promotions"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Get("/promotions", h.Promotions)
	router.Post("/promotions", h.CreatePromotion)
	router.Put("/promotions/{id}", h.UpdatePromotion)

	do := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&buf).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Authorization", "Bearer "+tok)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	// autoApply of the promotion `id` as the list and the sync pull report it (nil = field absent).
	listed := func(id string) *bool {
		t.Helper()
		code, body := do(http.MethodGet, "/promotions", nil)
		if code != http.StatusOK {
			t.Fatalf("GET /promotions = %d %v", code, body)
		}
		for _, d := range body["data"].([]any) {
			row := d.(map[string]any)
			if row["id"] == id {
				v, ok := row["autoApply"].(bool)
				if !ok {
					return nil
				}
				return &v
			}
		}
		t.Fatalf("promotion %s not listed", id)
		return nil
	}
	pulled := func(id string) *bool {
		t.Helper()
		b, err := syncpkg.New(pool, rd, nil, wr).Pull(ctx, read.Scope{OutletID: outlet}, outlet)
		if err != nil {
			t.Fatal(err)
		}
		// Decode the bundle as the tablet sees it (JSON), not through the Go type.
		raw, err := json.Marshal(b.Promotions)
		if err != nil {
			t.Fatal(err)
		}
		var rows []map[string]any
		if err := json.Unmarshal(raw, &rows); err != nil {
			t.Fatal(err)
		}
		for _, p := range rows {
			if p["id"] == id {
				v, ok := p["autoApply"].(bool)
				if !ok {
					return nil
				}
				return &v
			}
		}
		t.Fatalf("promotion %s not in the pull bundle", id)
		return nil
	}
	want := func(label string, got *bool, exp bool) {
		t.Helper()
		if got == nil || *got != exp {
			t.Fatalf("%s: autoApply = %v, want %v", label, got, exp)
		}
	}

	base := func() map[string]any {
		return map[string]any{"name": "AA promo", "type": "percentage", "value": 10, "isActive": true}
	}
	create := func(extra map[string]any) string {
		t.Helper()
		b := base()
		for k, v := range extra {
			b[k] = v
		}
		code, body := do(http.MethodPost, "/promotions", b)
		if code != http.StatusCreated {
			t.Fatalf("create = %d %v", code, body)
		}
		return body["data"].(map[string]any)["id"].(string)
	}

	idOn := create(map[string]any{"autoApply": true})
	want("list after create true", listed(idOn), true)
	want("pull after create true", pulled(idOn), true)

	idOmitted := create(nil)
	want("create without the field defaults false", listed(idOmitted), false)

	// PUT without the field keeps true (the stale-client wipe class).
	if code, body := do(http.MethodPut, "/promotions/"+idOn, base()); code != http.StatusOK && code != http.StatusNoContent {
		t.Fatalf("put without field = %d %v", code, body)
	}
	want("list after PUT without field", listed(idOn), true)
	want("pull after PUT without field", pulled(idOn), true)

	// PUT with an explicit false clears it.
	b := base()
	b["autoApply"] = false
	if code, body := do(http.MethodPut, "/promotions/"+idOn, b); code != http.StatusOK && code != http.StatusNoContent {
		t.Fatalf("put false = %d %v", code, body)
	}
	want("list after PUT false", listed(idOn), false)
	want("pull after PUT false", pulled(idOn), false)

	// autoApply + codeOnly is a 400 with the Indonesian message, on create and on update.
	conflict := base()
	conflict["autoApply"], conflict["codeOnly"] = true, true
	for _, c := range []struct{ method, path string }{{http.MethodPost, "/promotions"}, {http.MethodPut, "/promotions/" + idOn}} {
		code, body := do(c.method, c.path, conflict)
		if code != http.StatusBadRequest {
			t.Fatalf("%s conflict = %d %v, want 400", c.method, code, body)
		}
		if msg, _ := body["error"].(string); msg != "Promo otomatis tidak bisa sekaligus hanya via kode" {
			t.Fatalf("%s conflict message = %q", c.method, msg)
		}
	}
	want("rejected update left the row alone", listed(idOn), false)

	// A stale client turning codeOnly on without the field must not leave both flags set: auto clears.
	idBoth := create(map[string]any{"autoApply": true})
	stale := base()
	stale["codeOnly"] = true
	if code, body := do(http.MethodPut, "/promotions/"+idBoth, stale); code != http.StatusOK && code != http.StatusNoContent {
		t.Fatalf("put codeOnly without autoApply = %d %v", code, body)
	}
	want("list after codeOnly on clears auto", listed(idBoth), false)
	want("pull after codeOnly on clears auto", pulled(idBoth), false)
}
