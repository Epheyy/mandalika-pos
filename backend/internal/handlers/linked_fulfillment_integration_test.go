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

// Fresh opt-in cluster only. No .env/application config loading, no live fallback,
// no reuse or cleanup of the previously stopped S0c/S0d/BE fixture directories.
func TestLinkedFulfillmentPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_LF_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated linked-fulfillment PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56442 || cfg.ConnConfig.Database != "mandalika_lf_synthetic" || cfg.ConnConfig.User != "lf_test" {
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
	expected := os.Getenv("MANDALIKA_LF_TEST_DATA_DIR")
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
	var fixture struct {
		Products []struct {
			ID, Name string
			Variants []struct {
				Size, SKU string
				Price     float64
			}
		}
		Promotions []struct {
			ID, Name, Type string
			BXGYConfig     json.RawMessage `json:"bxgyConfig"`
			BundleConfig   json.RawMessage `json:"bundleConfig"`
		}
		Cases []struct {
			Name, Kind, PromotionID, Code string
			ExpectedTotal                 float64
			ExpectedRewardNet             float64
			ExpectedQuantities            map[string]int
			ExpectedGrants                int
			Item                          struct {
				Type, IdempotencyKey string
				Payload              json.RawMessage
			}
		}
	}
	raw, err := os.ReadFile("testdata/linked_fulfillment_orders.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 4 || len(fixture.Products) != 2 || len(fixture.Promotions) != 2 {
		t.Fatal("unexpected shared fixture coverage")
	}
	const outlet = "00000000-0000-4000-8300-000000000090"
	const cashier = "00000000-0000-4000-8300-000000000091"
	exec(`INSERT INTO outlets(id,name) VALUES($1,'LF synthetic outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'lf@example.invalid','not-a-login-hash','LF synthetic cashier','cashier',$2)`, cashier, outlet)
	for _, p := range fixture.Products {
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, p.ID, p.Name)
		for _, v := range p.Variants {
			exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,$3,100,$4)`, p.ID, v.Size, v.Price, v.SKU)
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,100)`, outlet, p.ID, v.Size)
		}
	}
	for _, p := range fixture.Promotions {
		exec(`INSERT INTO promotions(id,name,type,value,combinable,code_only,bxgy_config,bundle_config) VALUES($1,$2,$3,0,true,false,$4::jsonb,$5::jsonb)`, p.ID, p.Name, p.Type, string(p.BXGYConfig), string(p.BundleConfig))
		exec(`INSERT INTO discount_codes(code,promotion_id,type,value,combinable) VALUES($1,$2,'fixed',0,true)`, "Raw-LF-"+p.Type, p.ID)
	}
	exec(`UPDATE loyalty_settings SET enabled=false`)
	exec(`UPDATE app_settings SET tax_enabled=false,rounding_enabled=false`)
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("LF-SYNTHETIC-TEST-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, cashier, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	wrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	direct := wrap(mw.RequirePermission("create_order")(http.HandlerFunc(h.CreateOrder)))
	batch := wrap(http.HandlerFunc(h.SyncBatch))
	snapshot := func() string {
		t.Helper()
		var data string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
		'orders',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM orders x),
		'items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM order_items x),
		'stock',(SELECT jsonb_agg(to_jsonb(x) ORDER BY product_id) FROM outlet_variant_stock x),
		'variants',(SELECT jsonb_agg(to_jsonb(x) ORDER BY product_id) FROM product_variants x),
		'codes',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM discount_codes x),
		'grants',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM promo_reward_grants x),
		'points',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM point_transactions x),
		'keys',(SELECT jsonb_agg(to_jsonb(x) ORDER BY idempotency_key) FROM processed_keys x))::text`).Scan(&data)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	seq := 0
	for _, route := range []string{"direct", "batch"} {
		for _, c := range fixture.Cases {
			t.Run(route+"/"+c.Name, func(t *testing.T) {
				// Same mechanics/P for both modes; code-only flag exercised on the
				// linked path. This changes synthetic fixture data only.
				exec(`UPDATE promotions SET code_only=$2 WHERE id=$1`, c.PromotionID, c.Kind == "code")
				seq++
				var payload map[string]any
				if err := json.Unmarshal(c.Item.Payload, &payload); err != nil {
					t.Fatal(err)
				}
				// Distinct operation namespace per route; all financial/provenance
				// fields are exactly the real client-generated fixture values.
				payload["orderUuid"] = fmt.Sprintf("00000000-0000-4000-8301-%012d", seq)
				key := c.Item.IdempotencyKey + ":" + route
				var body any = payload
				path, handler := "/orders", direct
				if route == "batch" {
					path, handler = "/sync/batch", batch
					body = map[string]any{"items": []any{map[string]any{"type": c.Item.Type, "idempotencyKey": key, "payload": payload}}}
				}
				raw, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				request := func() *httptest.ResponseRecorder {
					r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
					r.Header.Set("Authorization", "Bearer "+token)
					r.Header.Set("Idempotency-Key", key)
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					return w
				}
				var usageBefore int
				if err = pool.QueryRow(ctx, `SELECT usage_count FROM discount_codes WHERE code=$1`, c.Code).Scan(&usageBefore); err != nil {
					t.Fatal(err)
				}
				stockBefore := map[string]int{}
				for productID := range c.ExpectedQuantities {
					var stock int
					if err = pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outlet, productID).Scan(&stock); err != nil {
						t.Fatal(err)
					}
					stockBefore[productID] = stock
				}
				w := request()
				if route == "direct" && w.Code != 201 {
					t.Fatalf("direct status=%d body=%s", w.Code, w.Body.String())
				}
				if route == "batch" {
					var response struct{ Data syncpkg.BatchResult }
					if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || len(response.Data.Results) != 1 || response.Data.Results[0].Status != "ok" {
						t.Fatalf("batch status=%d body=%s err=%v", w.Code, w.Body.String(), err)
					}
				}
				var orderID string
				var total, paid float64
				var codes []byte
				var warning bool
				if err = pool.QueryRow(ctx, `SELECT id,total,amount_paid,COALESCE(applied_discount_codes,'[]'::jsonb),discount_warning FROM orders WHERE idempotency_key=$1`, key).Scan(&orderID, &total, &paid, &codes, &warning); err != nil {
					t.Fatal(err)
				}
				if total != c.ExpectedTotal || paid != c.ExpectedTotal || warning {
					t.Fatalf("money/parity total=%v paid=%v want=%v warning=%v", total, paid, c.ExpectedTotal, warning)
				}
				var applied []string
				if err = json.Unmarshal(codes, &applied); err != nil {
					t.Fatal(err)
				}
				usageDelta := 0
				if c.Kind == "code" {
					usageDelta = 1
					if len(applied) != 1 || applied[0] != c.Code {
						t.Fatalf("raw code provenance: %s", codes)
					}
				} else if len(applied) != 0 {
					t.Fatalf("direct consumed code: %s", codes)
				}
				var usage, grants int
				var net float64
				if err = pool.QueryRow(ctx, `SELECT usage_count FROM discount_codes WHERE code=$1`, c.Code).Scan(&usage); err != nil {
					t.Fatal(err)
				}
				if err = pool.QueryRow(ctx, `SELECT count(*),COALESCE(sum(reward_price),0) FROM promo_reward_grants WHERE order_id=$1 AND promotion_id=$2`, orderID, c.PromotionID).Scan(&grants, &net); err != nil {
					t.Fatal(err)
				}
				if usage != usageBefore+usageDelta || grants != c.ExpectedGrants || net != c.ExpectedRewardNet {
					t.Fatalf("usage=%d before=%d expectedDelta=%d grants=%d net=%v", usage, usageBefore, usageDelta, grants, net)
				}
				for productID, expectedQty := range c.ExpectedQuantities {
					var qty, stock int
					if err = pool.QueryRow(ctx, `SELECT sum(quantity) FROM order_items WHERE order_id=$1 AND product_id=$2`, orderID, productID).Scan(&qty); err != nil {
						t.Fatal(err)
					}
					if err = pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outlet, productID).Scan(&stock); err != nil {
						t.Fatal(err)
					}
					if qty != expectedQty || stock != stockBefore[productID]-expectedQty {
						t.Fatalf("quantity/stock %s qty=%d stock=%d before=%d", productID, qty, stock, stockBefore[productID])
					}
				}
				// Treat the first committed response as lost; same raw body and key
				// are submitted twice more. Full business rows, not just counts,
				// must stay unchanged (including grants and captured evidence).
				committed := snapshot()
				for i := 0; i < 2; i++ {
					retry := request()
					if retry.Code >= 400 || snapshot() != committed {
						t.Fatalf("same-key retry changed effects: status=%d body=%s", retry.Code, retry.Body.String())
					}
					if route == "batch" {
						var result struct{ Data syncpkg.BatchResult }
						if err := json.Unmarshal(retry.Body.Bytes(), &result); err != nil || len(result.Data.Results) != 1 || result.Data.Results[0].IdempotencyKey != key || (result.Data.Results[0].Status != "duplicate" && result.Data.Results[0].Status != "ok") {
							t.Fatalf("retry did not acknowledge original key: %s err=%v", retry.Body.String(), err)
						}
					} else if retry.Code != 201 {
						t.Fatalf("direct retry status=%d", retry.Code)
					}
				}
				t.Logf("total=%v, physical units=2, reward grants=%d net=%v, code usage delta=%d; two same-body/key retries unchanged", total, grants, net, usageDelta)
			})
		}
	}
	t.Run("semantic-keys", func(t *testing.T) { verifySemanticPromotionKeys(t, ctx, pool, direct, batch, token, snapshot) })
	t.Run("guest-sales", func(t *testing.T) { verifyGuestSales(t, ctx, pool, direct, batch, token, snapshot) })
}
