package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
)

// Ringkasan aggregate parity (docs/plans/2026-11-04-ringkasan-dashboard-aggregate.md, section 7).
// Opt-in synthetic cluster (port 26479, prefix DB). The same fixture feeds the backoffice vitest suite:
//
//	GET /orders (the exact calls Dashboard makes)  == list-dumps.json     -> vitest runs metrics.ts over them
//	GET /reports/dashboard                          == expected-aggregate.json -> vitest maps it to the same view
//
// UPDATE_DASHBOARD_PARITY=1 rewrites both golden files (review the diff before committing).
func TestDashboardAggregatePostgres(t *testing.T) {
	pool, ctx := gatePool(t, "DB", 26479)
	var seed dpSeed
	dpLoad(t, "seed.json", &seed)
	var sc struct{ Scenarios []dpScenario }
	dpLoad(t, "scenarios.json", &sc)
	dpSeedDB(ctx, t, pool, seed)

	outletA, outletB := seed.Outlets[0].ID, seed.Outlets[1].ID
	const adminU, cashA = "00000000-0000-4000-8e07-000000000001", "00000000-0000-4000-8e07-000000000002"
	for _, u := range [][3]string{{adminU, "dp-admin@example.invalid", "admin"}, {cashA, "dp-cash@example.invalid", "cashier"}} {
		outlet := any(outletA)
		if u[2] == "admin" {
			outlet = nil
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$2,$3,$4)`, u[0], u[1], u[2], outlet); err != nil {
			t.Fatal(err)
		}
	}
	secret := []byte("DB-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, nil)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokens := map[string]string{"admin": issue(adminU, "admin", ""), "cashier": issue(cashA, "cashier", outletA)}
	// scope name -> (token, outletId query parameter)
	scopes := map[string][2]string{
		"admin-all": {"admin", "all"}, "admin-A": {"admin", outletA}, "admin-B": {"admin", outletB},
		"cashier-A": {"cashier", ""}, "cashier-A-foreign": {"cashier", outletB},
	}
	h := New(read.New(pool), nil, nil, nil, nil, nil, nil)
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Get("/orders", h.Orders)
	router.Get("/reports/dashboard", h.DashboardAggregate)
	get := func(path, token string, headers ...string) (int, []byte) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		for i := 0; i+1 < len(headers); i += 2 {
			r.Header.Set(headers[i], headers[i+1])
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes()
	}
	scopeQuery := func(scope string) (string, string) {
		s := scopes[scope]
		q := ""
		if s[1] != "" {
			q = "&outletId=" + s[1]
		}
		return tokens[s[0]], q
	}
	snapshot := func() string {
		var s string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object('o',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM orders x),
		  'i',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM order_items x),'r',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM order_refunds x))::text`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	before := snapshot()

	update := os.Getenv("UPDATE_DASHBOARD_PARITY") == "1"
	dumpsPath := filepath.Join(dpFixtureDir(t), "list-dumps.json")
	aggPath := filepath.Join(dpFixtureDir(t), "expected-aggregate.json")
	wantDumps, wantAgg := map[string]any{}, map[string]any{}
	if !update {
		dpLoad(t, "list-dumps.json", &wantDumps)
		dpLoad(t, "expected-aggregate.json", &wantAgg)
	}
	gotDumps, gotAgg := map[string]any{}, map[string]any{}
	decode := func(raw []byte) map[string]any {
		t.Helper()
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%v: %s", err, raw)
		}
		return m
	}

	t.Run("parity", func(t *testing.T) {
		for _, s := range sc.Scenarios {
			token, outletQ := scopeQuery(s.Scope)
			// 1. The two list calls Dashboard makes today (fetchAllPages, 200 per page).
			for _, basis := range []string{"sale", "refund"} {
				win := url.Values{}
				for k, v := range s.OrdersWindow {
					win.Set(k, v)
				}
				win.Set("page", "1")
				win.Set("limit", "200")
				if basis == "refund" {
					win.Set("dateBasis", "refund")
				}
				code, body := get("/orders?"+win.Encode()+outletQ, token)
				if code != http.StatusOK {
					t.Fatalf("%s %s orders: %d %s", s.Name, basis, code, body)
				}
				m := decode(body)
				if total, _ := m["meta"].(map[string]any)["total"].(float64); total > 200 {
					t.Fatalf("%s: %v orders need a second page; the dump assumes one", s.Name, total)
				}
				key := fmt.Sprintf("%s|%s|%s|%s", s.Scope, win.Get("dateFrom"), win.Get("dateTo"), basis)
				gotDumps[key] = m["data"]
			}
			// 2. The aggregate.
			q := url.Values{}
			for k, v := range s.Params {
				q.Set(k, fmt.Sprint(v))
			}
			code, body := get("/reports/dashboard?"+q.Encode()+outletQ, token)
			if code != http.StatusOK {
				t.Fatalf("%s dashboard: %d %s", s.Name, code, body)
			}
			gotAgg[s.Name] = decode(body)["data"]
		}
		if update {
			writeGolden(t, dumpsPath, gotDumps)
			writeGolden(t, aggPath, gotAgg)
			return
		}
		compareGolden(t, "list-dumps.json", wantDumps, gotDumps)
		compareGolden(t, "expected-aggregate.json", wantAgg, gotAgg)
	})

	t.Run("scope", func(t *testing.T) {
		q := "/reports/dashboard?dateFrom=2026-10-29&dateTo=2026-11-04&trend=day"
		_, own := get(q, tokens["cashier"])
		_, foreignParam := get(q+"&outletId="+outletB, tokens["cashier"])
		if !bytes.Equal(own, foreignParam) {
			t.Fatalf("a cashier's ?outletId=<other outlet> must clamp to their own outlet:\n%s\n%s", own, foreignParam)
		}
		if code, body := get(q, tokens["cashier"], "X-Outlet-Id", outletB); code != http.StatusForbidden {
			t.Fatalf("foreign X-Outlet-Id must be 403, got %d %s", code, body)
		}
		_, a := get(q+"&outletId="+outletA, tokens["admin"])
		_, b := get(q+"&outletId="+outletB, tokens["admin"])
		_, all := get(q+"&outletId=all", tokens["admin"])
		money := func(raw []byte) float64 {
			return decode(raw)["data"].(map[string]any)["current"].(map[string]any)["gross"].(float64)
		}
		if sum := money(a) + money(b); sum != money(all) || money(b) == 0 || money(a) == 0 {
			t.Fatalf("outlet A + outlet B gross must equal cross-outlet gross: %v + %v vs %v", money(a), money(b), money(all))
		}
		if code, _ := get(q, ""); code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated must be 401, got %d", code)
		}
	})

	t.Run("bad-input", func(t *testing.T) {
		ok := "dateFrom=2026-11-01&dateTo=2026-11-04&trend=day"
		for name, q := range map[string]string{
			"bad date":              "dateFrom=2026-13-45&dateTo=2026-11-04&trend=day",
			"bad prev date":         ok + "&prevDateFrom=yesterday&prevDateTo=2026-10-31",
			"from after to":         "dateFrom=2026-11-05&dateTo=2026-11-04&trend=day",
			"missing trend":         "dateFrom=2026-11-01&dateTo=2026-11-04",
			"bad trend":             "dateFrom=2026-11-01&dateTo=2026-11-04&trend=week",
			"half-open previous":    ok + "&prevDateFrom=2026-10-28",
			"overlapping previous":  ok + "&prevDateFrom=2026-10-28&prevDateTo=2026-11-01",
			"previous after":        ok + "&prevDateFrom=2026-11-05&prevDateTo=2026-11-06",
			"previous without from": "dateTo=2026-11-04&trend=month&prevDateFrom=2026-10-01&prevDateTo=2026-10-02",
			"bad tzOffset":          ok + "&tzOffset=900",
			"non-numeric tzOffset":  ok + "&tzOffset=abc",
		} {
			if code, body := get("/reports/dashboard?"+q, tokens["admin"]); code != http.StatusBadRequest {
				t.Errorf("%s: want 400, got %d %s", name, code, body)
			}
		}
	})

	t.Run("empty-window", func(t *testing.T) {
		code, body := get("/reports/dashboard?dateFrom=2020-01-01&dateTo=2020-01-02&trend=day&outletId=all", tokens["admin"])
		if code != http.StatusOK {
			t.Fatalf("%d %s", code, body)
		}
		for _, want := range []string{`"trend":[]`, `"topProducts":[]`, `"bottomProducts":[]`, `"cashiers":[]`, `"promoTally":[]`,
			`"grossByPaymentMethod":{}`, `"refundsByPaymentMethod":{}`, `"distinctProducts":0`, `"gross":0`, `"customers":0`} {
			if !strings.Contains(string(body), want) {
				t.Errorf("empty window must render %s: %s", want, body)
			}
		}
		if strings.Contains(string(body), `"previous"`) {
			t.Errorf("previous must be absent when no previous window is requested: %s", body)
		}
	})

	if after := snapshot(); after != before {
		t.Fatal("the dashboard and orders reads must not mutate any order row")
	}
}

func compareGolden(t *testing.T, name string, want, got map[string]any) {
	t.Helper()
	keys := func(m map[string]any) []string {
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	if !reflect.DeepEqual(keys(want), keys(got)) {
		t.Fatalf("%s: keys differ:\nwant %v\n got %v (UPDATE_DASHBOARD_PARITY=1 rewrites)", name, keys(want), keys(got))
	}
	for _, k := range keys(want) {
		if !reflect.DeepEqual(want[k], got[k]) {
			t.Errorf("%s[%s] differs at %s (UPDATE_DASHBOARD_PARITY=1 rewrites)", name, k, firstDiff("", want[k], got[k]))
		}
	}
}

// firstDiff names the first path where two decoded JSON values differ (keeps failures readable).
func firstDiff(path string, a, b any) string {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			return path + " (type)"
		}
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			if !reflect.DeepEqual(av[k], bv[k]) {
				return firstDiff(path+"."+k, av[k], bv[k])
			}
		}
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return fmt.Sprintf("%s (length %d vs %d)", path, len(av), len(bv))
		}
		for i := range av {
			if !reflect.DeepEqual(av[i], bv[i]) {
				return firstDiff(fmt.Sprintf("%s[%d]", path, i), av[i], bv[i])
			}
		}
	}
	return fmt.Sprintf("%s: want %v, got %v", path, a, b)
}

func writeGolden(t *testing.T, path string, v map[string]any) {
	t.Helper()
	raw, err := json.MarshalIndent(v, "", " ")
	if strings.HasPrefix(filepath.Base(path), "list-dumps") {
		raw, err = json.Marshal(v) // the order dumps are big; keep them compact
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
