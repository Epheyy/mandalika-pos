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

// Opt-in only. No application config/.env loading. Verify the freshly-created
// loopback cluster's data directory before applying any existing migrations.
// The test database must be empty; the runner owns its disposable lifecycle.
func TestSaleInputPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_S0C_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56439 || cfg.ConnConfig.Database != "mandalika_s0c_synthetic" || cfg.ConnConfig.User != "s0c_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_S0C_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
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
	const outlet = "00000000-0000-4000-8000-000000000001"
	const user = "00000000-0000-4000-8000-000000000002"
	const product = "00000000-0000-4000-8000-000000000003"
	const customer = "00000000-0000-4000-8000-000000000004"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'Synthetic outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'synthetic@example.invalid','not-a-login-hash','Synthetic cashier','cashier',$2)`, user, outlet)
	exec(`INSERT INTO products(id,name) VALUES($1,'Synthetic product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',110000,10,'SYNTHETIC')`, product)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',10)`, outlet, product)
	exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'Synthetic customer','synthetic-not-a-number',10)`, customer)
	exec(`UPDATE loyalty_settings SET enabled=true,points_per_thousand=1,redemption_rate=1000`)
	exec(`INSERT INTO discount_codes(code,type,value) VALUES('SYNTHETIC','fixed',1000)`)
	rd, wr, osvc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, osvc, syncpkg.New(pool, rd, osvc, wr), nil)
	secret := []byte("S0C-INTEGRATION-SYNTHETIC-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	direct := authWrap(mw.RequirePermission("create_order")(http.HandlerFunc(h.CreateOrder)))
	batch := authWrap(http.HandlerFunc(h.SyncBatch))
	request := func(handler http.Handler, path, key string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	seq := 0
	payload := func() map[string]any {
		seq++
		return map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8001-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "Synthetic product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
	}
	snapshot := func() string {
		t.Helper()
		var result string
		// All rows, including timestamps and captured fields; no mutation counts alone.
		const sql = `SELECT jsonb_build_object(
		'orders',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM orders x),
		'items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM order_items x),
		'stock',(SELECT jsonb_agg(to_jsonb(x) ORDER BY product_id) FROM outlet_variant_stock x),
		'customers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM customers x),
		'codes',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM discount_codes x),
		'points',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM point_transactions x),
		'conditions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM loyalty_condition_applications x),
		'grants',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM promo_reward_grants x),
		'keys',(SELECT jsonb_agg(to_jsonb(x) ORDER BY idempotency_key) FROM processed_keys x))::text`
		if err := pool.QueryRow(ctx, sql).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	// Seed the version row, which is infrastructure metadata, before comparisons.
	if _, err = h.Sync.Version(ctx, outlet); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"direct", "batch"} {
		t.Run("invalid effects/"+route, func(t *testing.T) {
			for _, bad := range []any{-1, 0, 1.5, "1", 2147483648} {
				p := payload()
				p["items"].([]map[string]any)[0]["quantity"] = bad
				p["customerId"] = customer
				p["discountCode"] = "SYNTHETIC"
				p["pointsRedeemed"] = 1
				p["Offline"] = true
				p["alreadyPaid"] = true
				p["role"] = "admin"
				key := fmt.Sprintf("invalid-%s-%d", route, seq)
				before := snapshot()
				if route == "direct" {
					w := request(direct, "/orders", key, p)
					if w.Code != 400 {
						t.Fatalf("status=%d %s", w.Code, w.Body.String())
					}
				} else {
					w := request(batch, "/sync/batch", key, map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}})
					var out struct {
						Data syncpkg.BatchResult `json:"data"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
						t.Fatal(err)
					}
					if w.Code != 200 || out.Data.Processed != 0 || len(out.Data.Results) != 1 || out.Data.Results[0].Status != "error" || out.Data.Results[0].IdempotencyKey != key {
						t.Fatalf("%d %s", w.Code, w.Body.String())
					}
				}
				if after := snapshot(); after != before {
					t.Fatal("rejected input changed persisted business rows")
				}
			}
		})
	}
	for _, kind := range []string{"cash", "bca", "free", "full-discount", "static-bundle"} {
		t.Run("valid/"+kind, func(t *testing.T) {
			p := payload()
			line := p["items"].([]map[string]any)[0]
			switch kind {
			case "bca":
				p["paymentMethod"] = "bca"
				delete(p, "amountPaid")
			case "free":
				line["price"] = 0
				line["subtotal"] = 0
				line["isReward"] = true
				p["amountPaid"] = 0
			case "full-discount":
				p["discountType"] = "fixed"
				p["discountValue"] = 100000
				p["amountPaid"] = 0
			case "static-bundle":
				line["isBundle"] = true
			}
			w := request(direct, "/orders", "valid-"+kind, p)
			if w.Code != 201 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			var total, paid float64
			if err := pool.QueryRow(ctx, `SELECT total,amount_paid FROM orders WHERE idempotency_key=$1`, "valid-"+kind).Scan(&total, &paid); err != nil {
				t.Fatal(err)
			}
			want := 100000.0
			if kind == "free" || kind == "full-discount" {
				want = 0
			}
			// A09: non-cash keeps the captured amount; bca with no amountPaid stores 0
			// (and is flagged, see TestTenderRulesPostgres) instead of being overwritten.
			wantPaid := want
			if kind == "bca" {
				wantPaid = 0
			}
			if total != want || paid != wantPaid {
				t.Fatalf("total=%v paid=%v", total, paid)
			}
		})
	}
	t.Run("invalid monetary effects", func(t *testing.T) {
		for _, field := range []string{"amountPaid", "discountValue", "surchargeValue", "subtotal", "price"} {
			p := payload()
			p["customerId"] = customer
			p["discountCode"] = "SYNTHETIC"
			p["pointsRedeemed"] = 1
			if field == "price" || field == "subtotal" {
				p["items"].([]map[string]any)[0][field] = -1
			} else {
				p[field] = -1
			}
			before := snapshot()
			w := request(direct, "/orders", "money-"+field, p)
			if w.Code != 400 || snapshot() != before {
				t.Fatalf("%s: %d %s", field, w.Code, w.Body.String())
			}
		}
	})
	t.Run("server reward and bundle allocations", func(t *testing.T) {
		const bxgy = "00000000-0000-4000-8000-000000000005"
		const bundle = "00000000-0000-4000-8000-000000000006"
		const rewardProduct = "00000000-0000-4000-8000-000000000007"
		// Separate-set BXGY requires disjoint buy/get products. Keep the original
		// numeric allocation assertions without relying on a now-invalid fixture.
		exec(`INSERT INTO products(id,name) VALUES($1,'Synthetic reward product')`, rewardProduct)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',110000,10,'SYNTHETIC-REWARD')`, rewardProduct)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',10)`, outlet, rewardProduct)
		exec(`INSERT INTO promotions(id,name,type,value,bxgy_config) VALUES($1,'Synthetic BXGY','buy_x_get_y',0,$2::jsonb)`, bxgy, fmt.Sprintf(`{"buyQuantity":1,"getQuantity":1,"buyProductIds":["%s"],"getProductIds":["%s"],"getDiscountKind":"percentage","getDiscountValue":50}`, product, rewardProduct))
		exec(`INSERT INTO promotions(id,name,type,value,bundle_config) VALUES($1,'Synthetic bundle','bundle',0,$2::jsonb)`, bundle, fmt.Sprintf(`{"slots":[{"productKeys":["%s"],"quantity":3}],"bundlePrice":1000}`, product))
		for _, promo := range []string{bxgy, bundle} {
			p := payload()
			key := "reward-" + promo
			p["promotionId"] = promo
			line := map[string]any{"productId": product, "productName": "Synthetic product", "variantSize": "110ml", "price": 55000, "quantity": 1, "subtotal": 55000, "isReward": true, "rewardPromotionId": promo}
			if promo == bxgy {
				line["productId"] = rewardProduct
				p["items"] = append(p["items"].([]map[string]any), line)
				p["amountPaid"] = 155000
			} else {
				line["price"] = 333.3333
				line["quantity"] = 3
				line["subtotal"] = 1000
				p["items"] = []map[string]any{line}
				p["amountPaid"] = 1000
			}
			w := request(direct, "/orders", key, p)
			if w.Code != 201 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			var grants, qty int
			var net, total float64
			if err := pool.QueryRow(ctx, `SELECT count(*),sum(reward_price) FROM promo_reward_grants WHERE order_id=(SELECT id FROM orders WHERE idempotency_key=$1)`, key).Scan(&grants, &net); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT sum(quantity),sum(subtotal) FROM order_items WHERE order_id=(SELECT id FROM orders WHERE idempotency_key=$1)`, key).Scan(&qty, &total); err != nil {
				t.Fatal(err)
			}
			if promo == bxgy && (grants != 1 || net != 55000 || qty != 2 || total != 155000) {
				t.Fatalf("BXGY grants=%d net=%v qty=%d subtotal=%v", grants, net, qty, total)
			}
			if promo == bundle && (grants != 3 || net != 1000 || qty != 3 || total != 1000) {
				t.Fatalf("bundle grants=%d net=%v qty=%d subtotal=%v", grants, net, qty, total)
			}
		}
	})
	t.Run("mixed batch trusted mapping shortage quote and retries", func(t *testing.T) {
		exec(`UPDATE outlet_variant_stock SET stock=0`)
		exec(`UPDATE app_settings SET tax_enabled=true,tax_rate=10`)
		good, bad := payload(), payload()
		good["outletId"] = "forged"
		good["cashierId"] = "forged"
		good["clientCreatedAt"] = "2020-01-01T00:00:00Z"
		bad["items"].([]map[string]any)[0]["quantity"] = -1
		items := []any{map[string]any{"type": "order", "idempotencyKey": "mixed-good", "payload": good}, map[string]any{"type": "order", "idempotencyKey": "mixed-bad", "payload": bad}, map[string]any{"type": "refund", "idempotencyKey": "denied-refund", "payload": map[string]any{"CanRefund": true, "alreadyPaid": true}}}
		w := request(batch, "/sync/batch", "", map[string]any{"items": items})
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || out.Data.Processed != 1 || len(out.Data.Results) != 3 || out.Data.Results[0].Status != "ok" || !out.Data.Results[0].StockWarning || out.Data.Results[1].Status != "error" || out.Data.Results[2].Status != "error" {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var stock int
		var total, paid float64
		var quoted *float64
		var savedOutlet, savedUser string
		if err := pool.QueryRow(ctx, `SELECT total,amount_paid,quoted_total,outlet_id,cashier_id FROM orders WHERE idempotency_key='mixed-good'`).Scan(&total, &paid, &quoted, &savedOutlet, &savedUser); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, product).Scan(&stock); err != nil {
			t.Fatal(err)
		}
		// Catalog is now 110000, captured price 100000, current tax adds 10000.
		// A10: this legacy payload carries no quote, so quoted_total is NULL (it used to
		// be the server's own recompute, which made the receipt total unrecoverable).
		if stock != -1 || total != 110000 || paid != 100000 || quoted != nil || savedOutlet != outlet || savedUser != user {
			t.Fatalf("stock=%d total=%v paid=%v quoted=%v scope=%s/%s", stock, total, paid, quoted, savedOutlet, savedUser)
		}
		before := snapshot()
		for _, qty := range []int{1, -1} {
			good["items"].([]map[string]any)[0]["quantity"] = qty
			w = request(batch, "/sync/batch", "", map[string]any{"items": items[:1]})
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if out.Data.Results[0].Status != "duplicate" || out.Data.Results[0].OrderID == "" || out.Data.Results[0].IdempotencyKey != "mixed-good" || snapshot() != before {
				t.Fatalf("same-key retry mutated rows: %s", w.Body.String())
			}
		}
	})
	var migrations int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	t.Logf("Applied %d existing migrations; real authenticated direct/batch handlers, services and PostgreSQL rows exercised; no external payment provider, Redis or device persistence", migrations)
}
