package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A23: the server path (resolvePromos/loadPromoSpec) must price a promotion the
// same whether it arrives directly (promotionIds) or through a linked discount
// code. Fresh opt-in cluster only, same isolation contract as the LF gate.
func TestPromoLinkedParityPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_PL_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated promo-linked-parity PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56460 || cfg.ConnConfig.Database != "mandalika_pl_synthetic" || cfg.ConnConfig.User != "pl_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_PL_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const outlet = "00000000-0000-4000-8500-000000000090"
	const cashier = "00000000-0000-4000-8500-000000000091"
	const p1, p2 = "00000000-0000-4000-8500-000000000001", "00000000-0000-4000-8500-000000000002"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'PL synthetic outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'pl@example.invalid','not-a-login-hash','PL synthetic cashier','cashier',$2)`, cashier, outlet)
	prices := map[string]float64{p1: 100000, p2: 50000}
	for id, price := range prices {
		exec(`INSERT INTO products(id,name) VALUES($1::uuid,$1::text)`, id)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'M',$2,1000,$3)`, id, price, "SKU-"+id[len(id)-3:])
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',1000)`, outlet, id)
	}
	exec(`UPDATE loyalty_settings SET enabled=false`)
	exec(`UPDATE app_settings SET tax_enabled=false,rounding_enabled=false`)

	type line struct {
		ID  string
		Qty int
	}
	cases := []struct {
		Name, PromoID, Type, Code, Scope, BXGY, Tiered string
		Value                                          float64
		Cart                                           []line
		Total, Discount                                float64
	}{
		{Name: "tiered", PromoID: "00000000-0000-4000-8500-000000000101", Type: "tiered", Code: "Raw-PL-tiered",
			Tiered: `{"tiers":[{"minSubtotal":50000,"kind":"percentage","value":10}]}`,
			Cart:   []line{{p1, 1}}, Total: 90000, Discount: 10000},
		{Name: "scoped_percentage", PromoID: "00000000-0000-4000-8500-000000000102", Type: "percentage", Code: "Raw-PL-pct", Value: 20,
			Scope: `["` + p1 + `"]`, Cart: []line{{p1, 1}, {p2, 1}}, Total: 130000, Discount: 20000},
		{Name: "bogo", PromoID: "00000000-0000-4000-8500-000000000103", Type: "bogo", Code: "Raw-PL-bogo",
			Cart: []line{{p2, 2}}, Total: 50000, Discount: 50000},
		{Name: "bxgy_same_set", PromoID: "00000000-0000-4000-8500-000000000104", Type: "buy_x_get_y", Code: "Raw-PL-bxgy",
			BXGY: `{"buyQuantity":1,"getQuantity":1,"buyProductIds":["` + p2 + `"],"getProductIds":[],"getDiscountKind":"percentage","getDiscountValue":100,"maxApplications":0}`,
			Cart: []line{{p2, 2}}, Total: 50000, Discount: 50000},
	}
	for _, c := range cases {
		scope := c.Scope
		if scope == "" {
			scope = "[]"
		}
		exec(`INSERT INTO promotions(id,name,type,value,combinable,code_only,applicable_product_ids,bxgy_config,tiered_config)
		      VALUES($1,$2,$3,$4,true,false,$5::jsonb,NULLIF($6,'')::jsonb,NULLIF($7,'')::jsonb)`, c.PromoID, c.Name, c.Type, c.Value, scope, c.BXGY, c.Tiered)
		// The code's own flat value is a decoy: a linked code must price from the promotion.
		exec(`INSERT INTO discount_codes(code,promotion_id,type,value,combinable) VALUES($1,$2,'fixed',987,true)`, c.Code, c.PromoID)
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("PL-SYNTHETIC-TEST-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, cashier, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	wrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	direct := wrap(mw.RequirePermission("create_order")(http.HandlerFunc(h.CreateOrder)))

	seq := 0
	type outcome struct {
		status          int
		total, discount float64
		warning         bool
		appliedCodes    []string
		body, key       string
	}
	place := func(t *testing.T, c int, promoIDs, codes []string) outcome {
		t.Helper()
		seq++
		uuid := fmt.Sprintf("00000000-0000-4000-8501-%012d", seq)
		var items []map[string]any
		var subtotal float64
		for _, l := range cases[c].Cart {
			sub := prices[l.ID] * float64(l.Qty)
			subtotal += sub
			items = append(items, map[string]any{"productId": l.ID, "productName": l.ID, "variantSize": "M", "price": prices[l.ID], "quantity": l.Qty, "subtotal": sub})
		}
		// Tender is the hand-computed expected total, so a server price that
		// drifts from it is rejected by the tender rule and fails loudly here.
		payload := map[string]any{"items": items, "paymentMethod": "cash", "amountPaid": subtotal - cases[c].Discount,
			"promotionIds": promoIDs, "discountCodes": codes, "orderUuid": uuid}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", "/orders", strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Idempotency-Key", uuid)
		w := httptest.NewRecorder()
		direct.ServeHTTP(w, r)
		o := outcome{status: w.Code, body: w.Body.String(), key: uuid}
		if w.Code != 201 {
			return o
		}
		var applied []byte
		if err = pool.QueryRow(ctx, `SELECT total,discount_amount,discount_warning,COALESCE(applied_discount_codes,'[]'::jsonb) FROM orders WHERE idempotency_key=$1`, uuid).Scan(&o.total, &o.discount, &o.warning, &applied); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(applied, &o.appliedCodes); err != nil {
			t.Fatal(err)
		}
		return o
	}
	usage := func(code string) (n int) {
		if err := pool.QueryRow(ctx, `SELECT usage_count FROM discount_codes WHERE code=$1`, code).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return
	}

	for i, c := range cases {
		t.Run("direct-equals-linked/"+c.Name, func(t *testing.T) {
			d := place(t, i, []string{c.PromoID}, []string{})
			l := place(t, i, []string{}, []string{c.Code})
			if d.status != 201 || l.status != 201 {
				t.Fatalf("direct=%d %s linked=%d %s", d.status, d.body, l.status, l.body)
			}
			if d.total != c.Total || d.discount != c.Discount || d.warning {
				t.Fatalf("direct total=%v discount=%v warning=%v want %v/%v", d.total, d.discount, d.warning, c.Total, c.Discount)
			}
			if l.total != d.total || l.discount != d.discount || l.warning {
				t.Fatalf("linked total=%v discount=%v warning=%v differs from direct %v/%v", l.total, l.discount, l.warning, d.total, d.discount)
			}
			if len(d.appliedCodes) != 0 || len(l.appliedCodes) != 1 || l.appliedCodes[0] != c.Code {
				t.Fatalf("code provenance direct=%v linked=%v", d.appliedCodes, l.appliedCodes)
			}
		})
	}

	t.Run("direct-and-linked-same-promotion-discounts-once", func(t *testing.T) {
		c := cases[0]
		before := usage(c.Code)
		o := place(t, 0, []string{c.PromoID}, []string{c.Code})
		if o.status != 201 || o.total != c.Total || o.discount != c.Discount || o.warning {
			t.Fatalf("status=%d total=%v discount=%v warning=%v body=%s", o.status, o.total, o.discount, o.warning, o.body)
		}
		// The redundant code is skipped, so it is neither recorded nor consumed.
		if len(o.appliedCodes) != 0 || usage(c.Code) != before {
			t.Fatalf("redundant code consumed: applied=%v usage=%d before=%d", o.appliedCodes, usage(c.Code), before)
		}
	})

	t.Run("code-only-promotion-rejected-directly-priced-via-code", func(t *testing.T) {
		c := cases[0]
		exec(`UPDATE promotions SET code_only=true WHERE id=$1`, c.PromoID)
		defer exec(`UPDATE promotions SET code_only=false WHERE id=$1`, c.PromoID)
		d := place(t, 0, []string{c.PromoID}, []string{})
		if d.status != http.StatusUnprocessableEntity {
			t.Fatalf("direct code_only status=%d body=%s", d.status, d.body)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders WHERE idempotency_key=$1`, d.key).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rejected order was persisted: n=%d err=%v", n, err)
		}
		l := place(t, 0, []string{}, []string{c.Code})
		if l.status != 201 || l.total != c.Total || l.discount != c.Discount || l.warning {
			t.Fatalf("linked code_only status=%d total=%v discount=%v warning=%v body=%s", l.status, l.total, l.discount, l.warning, l.body)
		}
	})
}
