package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A30 customer privacy: phone-only cashier lookup, role-scoped customer reads, a stripped
// pull bundle and a restricted order search. Opt-in only, same isolation contract as the
// other PostgreSQL gates (fixture "CP", port 56464).
func TestCustomerPrivacyPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "CP", 56464)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("sql normalize_phone matches the shared vectors", func(t *testing.T) {
		raw, err := os.ReadFile("../../../packages/sync/src/__fixtures__/phone-vectors.json")
		if err != nil {
			t.Fatal(err)
		}
		var vs []struct{ Input, Norm string }
		if err := json.Unmarshal(raw, &vs); err != nil {
			t.Fatal(err)
		}
		for _, v := range vs {
			var got string
			if err := pool.QueryRow(ctx, `SELECT normalize_phone($1)`, v.Input).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != v.Norm {
				t.Errorf("normalize_phone(%q) = %q, want %q", v.Input, got, v.Norm)
			}
		}
	})

	t.Run("phone_norm is generated and indexed", func(t *testing.T) {
		exec(`INSERT INTO customers(id,name,phone) VALUES('00000000-0000-4000-8f20-0000000000a1','CP gen','+62 812-0000-1111')`)
		var norm string
		if err := pool.QueryRow(ctx, `SELECT phone_norm FROM customers WHERE id='00000000-0000-4000-8f20-0000000000a1'`).Scan(&norm); err != nil {
			t.Fatal(err)
		}
		if norm != "081200001111" {
			t.Fatalf("phone_norm = %q", norm)
		}
		var idx int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname='idx_customers_phone_norm'`).Scan(&idx); err != nil || idx != 1 {
			t.Fatalf("index missing: %d %v", idx, err)
		}
		exec(`DELETE FROM customers WHERE id='00000000-0000-4000-8f20-0000000000a1'`)
	})

	const (
		outlet   = "00000000-0000-4000-8f20-000000000001"
		uAdmin   = "00000000-0000-4000-8f20-000000000010"
		uMgrMC   = "00000000-0000-4000-8f20-000000000011"
		uMgrNo   = "00000000-0000-4000-8f20-000000000012"
		uCashier = "00000000-0000-4000-8f20-000000000013"
		uCashMC  = "00000000-0000-4000-8f20-000000000014"
		uCashRL  = "00000000-0000-4000-8f20-000000000015"
		custA    = "00000000-0000-4000-8f20-0000000000c1"
		custOld  = "00000000-0000-4000-8f20-0000000000c2"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'CP outlet')`, outlet)
	for _, u := range [][3]string{
		{uAdmin, "admin", "cp-admin"}, {uMgrMC, "manager", "cp-mgr-mc"}, {uMgrNo, "manager", "cp-mgr-no"},
		{uCashier, "cashier", "cp-cashier"}, {uCashMC, "cashier", "cp-cash-mc"}, {uCashRL, "cashier", "cp-cash-rl"},
	} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,$5)`,
			u[0], u[2]+"@example.invalid", u[2], u[1], outlet)
	}
	// Customers: A (full PII), a merged-away twin of A, and four soft duplicates of one phone.
	exec(`INSERT INTO customers(id,name,phone,email,birthday,anniversary,notes,points,created_at)
	      VALUES($1,'Alice Priv','0812-3456-7890','alice@example.invalid','1990-05-17','2015-06-01','secret note',120,'2026-01-01')`, custA)
	exec(`INSERT INTO customers(id,name,phone,merged_into,created_at) VALUES($1,'Alice Old','081234567890',$2,'2025-12-01')`, custOld, custA)
	for i, n := range []string{"Dup One", "Dup Two", "Dup Three", "Dup Four"} {
		exec(`INSERT INTO customers(id,name,phone,created_at) VALUES($1,$2,'+62 811 0000 2222',$3)`,
			"00000000-0000-4000-8f20-0000000000d"+string(rune('1'+i)), n, time.Date(2026, 2, 1+i, 0, 0, 0, 0, time.UTC))
	}

	// An order by Alice at this outlet (the old pull bundle shipped her as a "recent customer"),
	// and a discount code assigned to her.
	exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,customer_id,customer_name,subtotal,total,payment_method,status)
	      VALUES('00000000-0000-4000-8f20-0000000000e1','00000000-0000-4000-8f20-0000000000e2','CP-ORD-0001','cp-dev:e2',$1,$2,'cp-cashier',$3,'Alice Priv',100000,100000,'cash','completed')`, outlet, uCashier, custA)
	exec(`INSERT INTO discount_codes(id,code,type,value,customer_id) VALUES('00000000-0000-4000-8f20-0000000000f1','VIP-ALICE','fixed',5000,$1)`, custA)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	// A disabled (no Redis) cache still carries the in-memory rate-limit window.
	cc, err := cache.Connect(ctx, "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h := New(rd, cc, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("CP-INTEGRATION-SYNTHETIC-KEY")
	issue := func(uid, role string, perms ...string) string {
		tk, err := auth.IssueAccess(secret, time.Hour, uid, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	tok := map[string]string{
		"admin":   issue(uAdmin, "admin"),
		"mgrMC":   issue(uMgrMC, "manager", "manage_customers"),
		"mgrNo":   issue(uMgrNo, "manager", "view_reports"),
		"cashier": issue(uCashier, "cashier", "create_order"),
		"cashMC":  issue(uCashMC, "cashier", "create_order", "manage_customers"),
		"cashRL":  issue(uCashRL, "cashier", "create_order"),
		"promo":   issue(uMgrNo, "manager", "manage_promotions"),
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	// Mirror of the relevant routes in internal/server/server.go.
	router.Group(func(r chi.Router) {
		r.Use(authWrap)
		r.Get("/sync/customers/lookup", h.CustomersLookup)
		r.Get("/sync/pull", h.SyncPull)
		r.Get("/discount-codes", h.DiscountCodes)
		r.Get("/orders", h.Orders)
		r.Post("/sync/batch", h.SyncBatch)
		r.Group(func(r chi.Router) {
			r.Use(RequireCustomerReader())
			r.Get("/customers", h.Customers)
			r.Get("/customers/{id}", h.Customer)
			r.Get("/customers/by-phone", h.CustomersByPhone)
			r.Get("/customers/reminders", h.Reminders)
			r.Get("/customers/dup-candidates", h.DupCandidates)
			r.Get("/customers/{id}/points", h.PointTransactions)
		})
	})
	get := func(token, path string) (int, http.Header, string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Header(), w.Body.String()
	}
	decode := func(raw string) []map[string]any {
		t.Helper()
		var e struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			t.Fatalf("decode %q: %v", raw, err)
		}
		return e.Data
	}

	t.Run("customer read routes: admin and manage_customers manager only", func(t *testing.T) {
		paths := []string{"/customers", "/customers/" + custA, "/customers/by-phone?phone=0812-3456-7890",
			"/customers/reminders", "/customers/dup-candidates", "/customers/" + custA + "/points"}
		for _, who := range []string{"admin", "mgrMC"} {
			for _, p := range paths {
				if code, _, body := get(tok[who], p); code != http.StatusOK {
					t.Errorf("%s GET %s = %d %s", who, p, code, body)
				}
			}
		}
		for _, who := range []string{"mgrNo", "cashier", "cashMC"} {
			for _, p := range paths {
				code, _, body := get(tok[who], p)
				if code != http.StatusForbidden {
					t.Errorf("%s GET %s = %d, want 403", who, p, code)
				}
				if strings.Contains(body, "Alice") || strings.Contains(body, "alice@") {
					t.Errorf("%s GET %s leaked: %s", who, p, body)
				}
			}
		}
	})

	t.Run("by-phone dup check matches on the normalized phone", func(t *testing.T) {
		_, _, body := get(tok["admin"], "/customers/by-phone?phone=%2B62%20812%203456%207890")
		got := decode(body)
		if len(got) != 1 || got[0]["id"] != custA {
			t.Fatalf("by-phone = %s", body)
		}
	})

	lookup := func(who, query string) (int, http.Header, string) {
		return get(tok[who], "/sync/customers/lookup?"+query)
	}

	t.Run("lookup phone-only: name query returns nothing", func(t *testing.T) {
		for _, who := range []string{"cashier", "cashMC", "mgrNo"} {
			code, hdr, body := lookup(who, "q=Alice")
			if code != http.StatusOK || len(decode(body)) != 0 {
				t.Errorf("%s name lookup = %d %s", who, code, body)
			}
			if hdr.Get("X-Cache") != "" {
				t.Errorf("%s lookup must not be cached", who)
			}
		}
	})

	t.Run("lookup phone-only: short or invalid query returns empty", func(t *testing.T) {
		for _, q := range []string{"phone=0812", "phone=", "phone=abc12345678", "q=081"} {
			code, _, body := lookup("cashier", q)
			if code != http.StatusOK || len(decode(body)) != 0 {
				t.Errorf("%s = %d %s", q, code, body)
			}
		}
	})

	t.Run("lookup phone-only: any phone format finds the stored one, reduced fields", func(t *testing.T) {
		for _, q := range []string{"phone=%2B62%20812-3456-7890", "phone=081234567890", "phone=6281234567890", "q=0812-3456-7890"} {
			code, hdr, body := lookup("cashier", q)
			got := decode(body)
			if code != http.StatusOK || len(got) != 1 || got[0]["id"] != custA {
				t.Fatalf("%s = %d %s", q, code, body)
			}
			if hdr.Get("X-Cache") != "" {
				t.Errorf("%s served from cache", q)
			}
			for _, banned := range []string{"email", "birthday", "anniversary", "notes", "tags", "lastVisit"} {
				if _, has := got[0][banned]; has {
					t.Errorf("reduced lookup row leaks %q: %s", banned, body)
				}
			}
			for _, need := range []string{"id", "name", "phone", "points", "totalSpent", "visitCount", "createdAt"} {
				if _, has := got[0][need]; !has {
					t.Errorf("reduced lookup row missing %q: %s", need, body)
				}
			}
			if got[0]["points"] != float64(120) {
				t.Errorf("points = %v", got[0]["points"])
			}
		}
	})

	t.Run("lookup excludes merged customers; soft duplicates capped at 3 oldest first", func(t *testing.T) {
		// 081234567890 is stored on A and on the merged-away Alice Old: only A returns.
		_, _, body := lookup("cashier", "phone=081234567890")
		if got := decode(body); len(got) != 1 || got[0]["name"] != "Alice Priv" {
			t.Fatalf("merged leak: %s", body)
		}
		_, _, body = lookup("cashier", "phone=0811-0000-2222")
		got := decode(body)
		if len(got) != 3 || got[0]["name"] != "Dup One" || got[1]["name"] != "Dup Two" || got[2]["name"] != "Dup Three" {
			t.Fatalf("soft dups = %s", body)
		}
	})

	t.Run("lookup All scope keeps the typeahead (name search, full object)", func(t *testing.T) {
		for _, who := range []string{"admin", "mgrMC"} {
			code, hdr, body := lookup(who, "q=Alice")
			got := decode(body)
			if code != http.StatusOK || len(got) == 0 {
				t.Fatalf("%s typeahead = %d %s", who, code, body)
			}
			if hdr.Get("X-Cache") != "" {
				t.Errorf("%s typeahead must not be cached", who)
			}
			if got[0]["email"] != "alice@example.invalid" {
				t.Errorf("%s typeahead lost the full object: %s", who, body)
			}
		}
	})

	t.Run("lookup All scope with phone returns the matching customers, never a list", func(t *testing.T) {
		for _, who := range []string{"admin", "mgrMC"} {
			// A POS login of a customer reader sends only ?phone=: the right single customer, full object.
			for _, q := range []string{"phone=081234567890", "phone=%2B62%20812-3456-7890", "phone=6281234567890"} {
				code, hdr, body := lookup(who, q)
				got := decode(body)
				if code != http.StatusOK || len(got) != 1 || got[0]["id"] != custA {
					t.Fatalf("%s %s = %d %s", who, q, code, body)
				}
				if got[0]["email"] != "alice@example.invalid" {
					t.Errorf("%s %s lost the full object: %s", who, q, body)
				}
				if hdr.Get("X-Cache") != "" {
					t.Errorf("%s %s served from cache", who, q)
				}
			}
			// Soft duplicates of one phone: exactly those, not the rest of the table.
			_, _, body := lookup(who, "phone=0811-0000-2222")
			got := decode(body)
			if len(got) != 4 {
				t.Fatalf("%s soft dups = %s", who, body)
			}
			for _, row := range got {
				if !strings.HasPrefix(row["name"].(string), "Dup ") {
					t.Errorf("%s phone lookup leaked %v", who, row["name"])
				}
			}
			// A phone that matches nobody, a short number, and a non-phone are empty, not a list.
			for _, q := range []string{"phone=089999999999", "phone=0812", "phone=Alice"} {
				if code, _, body := lookup(who, q); code != http.StatusOK || len(decode(body)) != 0 {
					t.Errorf("%s %s = %d %s", who, q, code, body)
				}
			}
			// phone wins over q when both are sent.
			_, _, body = lookup(who, "phone=081234567890&q=Dup")
			if got := decode(body); len(got) != 1 || got[0]["id"] != custA {
				t.Errorf("%s phone must win over q: %s", who, body)
			}
		}
	})

	t.Run("lookup with no search text never returns a list, for any role", func(t *testing.T) {
		for _, who := range []string{"admin", "mgrMC", "mgrNo", "cashier", "cashMC"} {
			for _, q := range []string{"", "q=", "phone=", "q=%20%20", "limit=20", "q=&phone="} {
				code, _, body := lookup(who, q)
				if code != http.StatusOK || len(decode(body)) != 0 {
					t.Errorf("%s ?%s = %d %s", who, q, code, body)
				}
			}
		}
	})

	t.Run("lookup rate limit: invalid queries are free, the 31st valid one in a minute is 429", func(t *testing.T) {
		for i := 0; i < 40; i++ {
			if code, _, _ := lookup("cashRL", "phone=081"); code != http.StatusOK {
				t.Fatalf("short query %d = %d", i, code)
			}
		}
		for i := 1; i <= 30; i++ {
			if code, _, body := lookup("cashRL", "phone=081234567890"); code != http.StatusOK {
				t.Fatalf("valid lookup %d = %d %s", i, code, body)
			}
		}
		code, hdr, body := lookup("cashRL", "phone=081234567890")
		if code != http.StatusTooManyRequests {
			t.Fatalf("31st lookup = %d %s", code, body)
		}
		if hdr.Get("Retry-After") == "" {
			t.Error("429 without Retry-After")
		}
		// Another terminal account is not affected (limit is per user, not per IP).
		if code, _, _ := lookup("cashier", "phone=081234567890"); code != http.StatusOK {
			t.Errorf("other account throttled: %d", code)
		}
	})

	t.Run("pull bundle ships no customers and no discount-code customer names", func(t *testing.T) {
		for _, who := range []string{"cashier", "cashMC", "mgrMC", "admin"} {
			code, _, body := get(tok[who], "/sync/pull")
			if code != http.StatusOK {
				t.Fatalf("%s pull = %d %s", who, code, body)
			}
			var env struct {
				Data struct {
					Customers     []any            `json:"customers"`
					DiscountCodes []map[string]any `json:"discountCodes"`
				} `json:"data"`
			}
			if err := json.Unmarshal([]byte(body), &env); err != nil {
				t.Fatal(err)
			}
			if env.Data.Customers == nil || len(env.Data.Customers) != 0 {
				t.Errorf("%s pull customers must be an empty array, got %v", who, env.Data.Customers)
			}
			if len(env.Data.DiscountCodes) != 1 {
				t.Fatalf("%s pull discountCodes = %s", who, body)
			}
			dc := env.Data.DiscountCodes[0]
			if _, has := dc["customerName"]; has {
				t.Errorf("%s pull leaks customerName: %v", who, dc)
			}
			if dc["customerId"] != custA {
				t.Errorf("%s pull must keep customerId for the wrong_customer rule: %v", who, dc)
			}
			if strings.Contains(body, "Alice") || strings.Contains(body, "alice@") {
				t.Errorf("%s pull leaks customer data: %s", who, body)
			}
		}
	})

	t.Run("discount-codes list names the customer only for manage_promotions", func(t *testing.T) {
		for who, wantName := range map[string]bool{"admin": true, "promo": true, "cashier": false, "mgrMC": false} {
			code, _, body := get(tok[who], "/discount-codes")
			got := decode(body)
			if code != http.StatusOK || len(got) != 1 {
				t.Fatalf("%s discount-codes = %d %s", who, code, body)
			}
			_, has := got[0]["customerName"]
			if has != wantName {
				t.Errorf("%s customerName present=%v want %v: %s", who, has, wantName, body)
			}
			if got[0]["customerId"] != custA {
				t.Errorf("%s lost customerId: %s", who, body)
			}
		}
	})

	t.Run("orders q: customer name and phone substring only for customer readers", func(t *testing.T) {
		count := func(who, q string) int {
			t.Helper()
			code, _, body := get(tok[who], "/orders?q="+q)
			if code != http.StatusOK {
				t.Fatalf("%s /orders?q=%s = %d %s", who, q, code, body)
			}
			return len(decode(body))
		}
		// All scope: name and phone substring still search the order's customer.
		for _, who := range []string{"admin", "mgrMC"} {
			for _, q := range []string{"Alice", "0812-3456"} {
				if n := count(who, q); n != 1 {
					t.Errorf("%s q=%s = %d orders, want 1", who, q, n)
				}
			}
		}
		// PhoneOnly: the customer name and a phone substring find nothing.
		for _, who := range []string{"cashier", "cashMC", "mgrNo"} {
			for _, q := range []string{"Alice", "0812-3456", "Priv"} {
				if n := count(who, q); n != 0 {
					t.Errorf("%s q=%s = %d orders, want 0", who, q, n)
				}
			}
			// Order number, cashier name and the full phone in any format still work.
			for _, q := range []string{"CP-ORD", "cp-cashier", "%2B62%20812-3456-7890", "081234567890"} {
				if n := count(who, q); n != 1 {
					t.Errorf("%s q=%s = %d orders, want 1", who, q, n)
				}
			}
		}
	})

	// ERP review S-1: customer_create must never overwrite an existing customer.
	t.Run("sync customer_create cannot overwrite an existing customer", func(t *testing.T) {
		const (
			shift  = "00000000-0000-4000-8f20-0000000000b1"
			device = "00000000-0000-4000-8f20-0000000000b2"
			newID  = "00000000-0000-4000-8f20-0000000000b3"
		)
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'cp-cashier','open',now(),0)`, shift, outlet, uCashier)
		send := func(key, id, name, phone, email string) syncpkg.ItemResult {
			t.Helper()
			payload := map[string]any{"customerId": id, "name": name, "phone": phone}
			if email != "" {
				payload["email"] = email
			}
			raw, err := json.Marshal(map[string]any{"items": []map[string]any{{
				"type": "customer_create", "idempotencyKey": device + ":" + key, "payload": payload,
				"envelope": map[string]any{"v": 1, "outletId": outlet, "userId": uCashier, "deviceId": device,
					"capturedAt": time.Now().UTC().Format(time.RFC3339), "shiftId": shift},
			}}})
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/sync/batch", strings.NewReader(string(raw)))
			r.Header.Set("Authorization", "Bearer "+tok["cashier"])
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			var out struct {
				Data syncpkg.BatchResult `json:"data"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Data.Results) != 1 {
				t.Fatalf("batch status=%d body=%.300s", w.Code, w.Body.String())
			}
			return out.Data.Results[0]
		}
		row := func(id string) string {
			t.Helper()
			var s string
			if err := pool.QueryRow(ctx, `SELECT name||'|'||phone||'|'||COALESCE(email,'') FROM customers WHERE id=$1`, id).Scan(&s); err != nil {
				t.Fatal(err)
			}
			return s
		}
		dups := func() int {
			t.Helper()
			var n int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM customer_dup_candidates`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			return n
		}
		const stored = "Alice Priv|0812-3456-7890|alice@example.invalid"

		// 1. different data under a new key is refused, unchanged, and leaks nothing.
		res := send("s1-attack", custA, "Mallory Evil", "0899-9999-9999", "mallory@example.invalid")
		if res.Status != "error" || res.Code != "conflict" || res.Retryable == nil || *res.Retryable {
			t.Fatalf("overwrite attempt = %+v, want non-retryable conflict", res)
		}
		for _, v := range []string{"Alice", "0812", "alice@", "Mallory", "0899", "mallory@"} {
			if strings.Contains(res.Error, v) {
				t.Errorf("conflict message leaks %q: %s", v, res.Error)
			}
		}
		if got := row(custA); got != stored {
			t.Fatalf("customer A overwritten: %s", got)
		}

		// 2. identical replay under a new key succeeds with the same id and changes nothing.
		res = send("s2-replay", custA, "Alice Priv", "0812-3456-7890", "alice@example.invalid")
		if res.Status != "ok" || res.Error != "" || res.OrderID != custA {
			t.Fatalf("identical replay = %+v, want ok with id %s", res, custA)
		}
		if got := row(custA); got != stored {
			t.Fatalf("replay changed customer A: %s", got)
		}

		// 2b. email is not compared (it would be an email-guess oracle) and never written.
		res = send("s2b-email", custA, "Alice Priv", "0812-3456-7890", "guess@example.invalid")
		if res.Status != "ok" || res.OrderID != custA {
			t.Fatalf("different-email replay = %+v, want ok", res)
		}
		if got := row(custA); got != stored {
			t.Fatalf("email guess changed customer A: %s", got)
		}
		for i, c := range [][2]string{{"Other Name", "0812-3456-7890"}, {"Alice Priv", "0899-0000-0000"}} {
			res = send(fmt.Sprintf("s2c-%d", i), custA, c[0], c[1], "alice@example.invalid")
			if res.Status != "error" || res.Code != "conflict" {
				t.Fatalf("name/phone mismatch %v = %+v, want conflict", c, res)
			}
			if got := row(custA); got != stored {
				t.Fatalf("mismatch changed customer A: %s", got)
			}
		}

		// 2d. a replay of a customer that recorded a dup candidate records no second one.
		const dupID = "00000000-0000-4000-8f20-0000000000b4"
		before := dups()
		res = send("s2d-create", dupID, "Dup Of Alice", "0812-3456-7890", "")
		if res.Status != "ok" || dups() != before+1 {
			t.Fatalf("create with a shared raw phone: %+v dups %d -> %d, want one new candidate", res, before, dups())
		}
		// The pair is unique, so clear it: a re-record on replay would otherwise be a silent no-op.
		exec(`DELETE FROM customer_dup_candidates WHERE new_customer_id=$1`, dupID)
		before = dups()
		res = send("s2d-replay", dupID, "Dup Of Alice", "0812-3456-7890", "")
		if res.Status != "ok" || res.OrderID != dupID {
			t.Fatalf("dup replay = %+v", res)
		}
		if after := dups(); after != before {
			t.Fatalf("dup candidates %d -> %d after identical replay, want unchanged", before, after)
		}

		// 2e. a since-merged (tombstoned) customer: identical replay ok, mismatch conflict.
		const oldRow = "Alice Old|081234567890|"
		res = send("s2e-replay", custOld, "Alice Old", "081234567890", "")
		if res.Status != "ok" || res.OrderID != custOld {
			t.Fatalf("merged identical replay = %+v, want ok with id %s", res, custOld)
		}
		for i, c := range [][2]string{{"Not Old", "081234567890"}, {"Alice Old", "0855-5555-5555"}} {
			res = send(fmt.Sprintf("s2e-%d", i), custOld, c[0], c[1], "")
			if res.Status != "error" || res.Code != "conflict" {
				t.Fatalf("merged mismatch %v = %+v, want conflict", c, res)
			}
		}
		if got := row(custOld); got != oldRow {
			t.Fatalf("merged customer changed: %s", got)
		}
		var mi string
		if err := pool.QueryRow(ctx, `SELECT merged_into FROM customers WHERE id=$1`, custOld).Scan(&mi); err != nil || mi != custA {
			t.Fatalf("merged_into = %q %v", mi, err)
		}

		// 3. same key replay is served from the receipt.
		again := send("s2-replay", custA, "Alice Priv", "0812-3456-7890", "alice@example.invalid")
		if again.Status != "ok" && again.Status != "duplicate" {
			t.Fatalf("same-key replay = %+v", again)
		}

		// 4. a brand-new id is created.
		res = send("s4-new", newID, "Fresh Customer", "0877-1234-5678", "")
		if res.Status != "ok" {
			t.Fatalf("new customer = %+v", res)
		}
		if got := row(newID); got != "Fresh Customer|0877-1234-5678|" {
			t.Fatalf("new customer row = %s", got)
		}
	})
}
