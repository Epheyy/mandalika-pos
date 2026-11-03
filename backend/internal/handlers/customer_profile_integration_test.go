package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

// D-25 customer profile read. Opt-in only, same isolation contract as the other PostgreSQL
// gates (fixture "CPR", port 26475).
func TestCustomerProfilePostgres(t *testing.T) {
	pool, ctx := gatePool(t, "CPR", 26475)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const (
		oA       = "00000000-0000-4000-8f30-000000000001"
		oB       = "00000000-0000-4000-8f30-000000000002"
		uCashA   = "00000000-0000-4000-8f30-000000000010"
		uAdmin   = "00000000-0000-4000-8f30-000000000011"
		uNoOut   = "00000000-0000-4000-8f30-000000000012"
		custKeep = "00000000-0000-4000-8f30-0000000000c1"
		custOld  = "00000000-0000-4000-8f30-0000000000c2"
		catSeen  = "00000000-0000-4000-8f30-0000000000a1"
		catNew   = "00000000-0000-4000-8f30-0000000000a2"
		pSeen    = "00000000-0000-4000-8f30-0000000000b1"
		pNew     = "00000000-0000-4000-8f30-0000000000b2"
	)
	exec(`INSERT INTO outlets(id,name,code) VALUES($1,'CPR A','AAA'),($2,'CPR B','BBB')`, oA, oB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
	  ($1,'cpr-cash@example.invalid','x','cpr-cash','cashier',$3),($2,'cpr-admin@example.invalid','x','cpr-admin','admin',$3)`, uCashA, uAdmin, oA)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'cpr-no@example.invalid','x','cpr-no','cashier')`, uNoOut)
	exec(`INSERT INTO categories(id,name,sort_order) VALUES($1,'Floral',1),($2,'Woody',2)`, catSeen, catNew)
	exec(`INSERT INTO products(id,name,category_id) VALUES($1,'Rose',$3),($2,'Oud',$4)`, pSeen, pNew, catSeen, catNew)
	exec(`INSERT INTO customers(id,name,phone,points,total_spent,visit_count,created_at)
	      VALUES($1,'Rina','081200009999',70,2500000,4,'2026-01-01')`, custKeep)
	exec(`INSERT INTO customers(id,name,phone,merged_into) VALUES($1,'Rina old','081200009999',$2)`, custOld, custKeep)
	exec(`INSERT INTO customer_interactions(customer_id,type,interaction_date,note) VALUES($1,'catatan','2026-02-02','suka floral')`, custKeep)

	// Three completed orders at A (gaps 10 and 30 days), one at B, one refunded at A.
	order := func(n string, outlet, status string, at time.Time, total float64) string {
		id := "00000000-0000-4000-8f30-00000000e00" + n
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,customer_id,customer_name,subtotal,total,payment_method,status,created_at)
		      VALUES($1,gen_random_uuid(),$2,$3,$4,$5,'c',$6,'Rina',$7,$7,'cash',$8,$9)`,
			id, "CPR-"+n, "cpr:"+n, outlet, uCashA, custKeep, total, status, at)
		return id
	}
	now := time.Now().UTC()
	o1 := order("1", oA, "completed", now.AddDate(0, 0, -50), 100000)
	o2 := order("2", oA, "completed", now.AddDate(0, 0, -40), 200000)
	o3 := order("3", oA, "completed", now.AddDate(0, 0, -10), 300000)
	order("4", oB, "completed", now.AddDate(0, 0, -5), 400000)
	order("5", oA, "refunded", now.AddDate(0, 0, -1), 500000)
	item := func(oid string, qty int) {
		exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'Rose','50ml',100000,$3,100000*$3)`,
			oid, pSeen, qty)
	}
	item(o1, 1)
	item(o2, 2)
	item(o3, 3)
	// A Rp0 reward line on the newest order: flagged free, never a frequent item or a tried category.
	exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'Oud','10ml',0,1,0)`, o3, pNew)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	cc, err := cache.Connect(ctx, "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h := New(rd, cc, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("CPR-INTEGRATION-SYNTHETIC-KEY")
	issue := func(uid, role, outlet string, perms ...string) string {
		tk, err := auth.IssueAccess(secret, time.Hour, uid, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	cashier, admin := issue(uCashA, "cashier", oA, "create_order"), issue(uAdmin, "admin", oA)
	router := chi.NewRouter()
	router.Group(func(r chi.Router) {
		r.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
		r.Get("/sync/customers/{id}/profile", h.CustomerProfile)
	})
	get := func(token, path string) (int, string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	type profile struct {
		Data struct {
			Customer struct {
				Id         string
				Tier       string
				OrderCount int
			}
			LastOrders []struct {
				OutletCode string
				Lines      []struct {
					Name string
					Free bool
				}
			}
			FrequentItems []struct {
				Name  string
				Count int
			}
			Notes []struct{ Text string }
			Pitch struct {
				LastItem             *string
				UsualIntervalDays    *int
				NeverTriedCategories []string
			}
		}
	}
	fetch := func(token, path string) profile {
		t.Helper()
		code, body := get(token, path)
		if code != http.StatusOK {
			t.Fatalf("GET %s = %d %s", path, code, body)
		}
		var p profile
		if err := json.Unmarshal([]byte(body), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("cashier sees only their outlet's completed orders, no notes", func(t *testing.T) {
		p := fetch(cashier, "/sync/customers/"+custKeep+"/profile?phone=0812-0000-9999")
		if p.Data.Customer.Tier != "Gold" || p.Data.Customer.OrderCount != 4 {
			t.Fatalf("header = %+v", p.Data.Customer)
		}
		if len(p.Data.LastOrders) != 3 {
			t.Fatalf("want 3 outlet-A completed orders, got %d", len(p.Data.LastOrders))
		}
		free := 0
		for _, o := range p.Data.LastOrders {
			if o.OutletCode != "AAA" {
				t.Errorf("order from outlet %q leaked into outlet A's profile", o.OutletCode)
			}
			for _, l := range o.Lines {
				if l.Free {
					free++
				}
			}
		}
		if free != 1 {
			t.Errorf("free lines = %d, want 1", free)
		}
		if len(p.Data.Notes) != 0 {
			t.Errorf("cashier got notes: %+v", p.Data.Notes)
		}
		if p.Data.Pitch.UsualIntervalDays == nil || *p.Data.Pitch.UsualIntervalDays != 20 {
			t.Errorf("usualIntervalDays = %v, want 20", p.Data.Pitch.UsualIntervalDays)
		}
		if p.Data.Pitch.LastItem == nil || *p.Data.Pitch.LastItem != "Rose" {
			t.Errorf("lastItem = %v", p.Data.Pitch.LastItem)
		}
		if got := p.Data.Pitch.NeverTriedCategories; len(got) != 1 || got[0] != "Woody" {
			t.Errorf("neverTried = %v (a Rp0 reward line must not count as tried)", got)
		}
		if len(p.Data.FrequentItems) != 1 || p.Data.FrequentItems[0].Count != 6 {
			t.Errorf("frequent = %+v", p.Data.FrequentItems)
		}
	})

	t.Run("a cross-outlet admin sees every outlet and the notes", func(t *testing.T) {
		p := fetch(admin, "/sync/customers/"+custKeep+"/profile?outletId=all")
		if len(p.Data.LastOrders) != 4 || len(p.Data.Notes) != 1 {
			t.Fatalf("orders=%d notes=%d", len(p.Data.LastOrders), len(p.Data.Notes))
		}
		if n := len(fetch(admin, "/sync/customers/"+custKeep+"/profile").Data.LastOrders); n != 3 {
			t.Errorf("admin default scope should be their own outlet, got %d orders", n)
		}
	})

	t.Run("a phone-only caller needs the customer's own phone (A30): an id alone is a 404", func(t *testing.T) {
		for _, q := range []string{"", "?phone=", "?phone=081200000000", "?phone=12"} {
			code, body := get(cashier, "/sync/customers/"+custKeep+"/profile"+q)
			if code != http.StatusNotFound || strings.Contains(body, "Rina") || strings.Contains(body, "0812") {
				t.Errorf("cashier %q = %d %s", q, code, body)
			}
		}
		if code, _ := get(admin, "/sync/customers/"+custKeep+"/profile"); code != http.StatusOK {
			t.Errorf("a customer reader needs no phone, got %d", code)
		}
	})

	t.Run("a merged-away id answers with the keeper", func(t *testing.T) {
		if got := fetch(cashier, "/sync/customers/"+custOld+"/profile?phone=081200009999").Data.Customer.Id; got != custKeep {
			t.Fatalf("merged id resolved to %s", got)
		}
	})

	t.Run("a malformed outletId is a 400, not a 500", func(t *testing.T) {
		if code, _ := get(admin, "/sync/customers/"+custKeep+"/profile?outletId=urn:uuid:"+oA); code != http.StatusBadRequest {
			t.Errorf("urn outletId = %d", code)
		}
	})

	t.Run("unknown and malformed ids do not leak", func(t *testing.T) {
		if code, _ := get(cashier, "/sync/customers/00000000-0000-4000-8f30-0000000000ff/profile"); code != http.StatusNotFound {
			t.Errorf("unknown id = %d", code)
		}
		if code, body := get(cashier, "/sync/customers/not-a-uuid/profile"); code != http.StatusNotFound || strings.Contains(body, "Rina") {
			t.Errorf("malformed id = %d %s", code, body)
		}
	})

	t.Run("a user without an outlet sees no orders", func(t *testing.T) {
		tk := issue(uNoOut, "cashier", "", "create_order")
		if n := len(fetch(tk, "/sync/customers/"+custKeep+"/profile?phone=081200009999").Data.LastOrders); n != 0 {
			t.Fatalf("outlet-less caller saw %d orders", n)
		}
		_, body := get(tk, "/sync/customers/"+custKeep+"/profile?phone=081200009999")
		if !strings.Contains(body, `"lastAt":null`) || !strings.Contains(body, `"lastItem":null`) || !strings.Contains(body, `"usualIntervalDays":null`) {
			t.Errorf("an empty pitch must be null, not zero values: %s", body)
		}
	})

	t.Run("a phone-only caller is rate limited on profile reads, a reader is not", func(t *testing.T) {
		var last int
		for i := 0; i < profilePerMinute+2; i++ {
			last, _ = get(cashier, "/sync/customers/"+custKeep+"/profile?phone=000000000000")
		}
		if last != http.StatusTooManyRequests {
			t.Errorf("cashier after %d reads = %d, want 429", profilePerMinute+2, last)
		}
		if code, _ := get(admin, "/sync/customers/"+custKeep+"/profile"); code != http.StatusOK {
			t.Errorf("reader = %d", code)
		}
	})
}
