package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/promotionkeys"
	"github.com/mandalika/pos-backend/internal/promotionpreflight"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Called only after the existing LF harness has verified its fresh synthetic
// target, migrated it, and tested all eight valid direct/code fulfillment cases.
func verifySemanticPromotionKeys(t *testing.T, ctx context.Context, pool *pgxpool.Pool, direct, batch http.Handler, token string, snapshot func() string) {
	t.Helper()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	wr := write.New(pool)
	promotionsSnapshot := func() string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object('promotions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM promotions p),'versions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY outlet_id) FROM content_versions v))::text`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	t.Run("authoring", func(t *testing.T) {
		var vectors []struct {
			Name        string
			Left, Right []string
			Overlap     bool
		}
		raw, err := os.ReadFile("../promotionkeys/testdata/overlap.json")
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(raw, &vectors); err != nil {
			t.Fatal(err)
		}
		for _, v := range vectors {
			for _, kind := range []string{"bundle", "buy_x_get_y"} {
				if kind == "bundle" && (len(v.Left) == 0 || len(v.Right) == 0) {
					continue
				}
				t.Run(kind+"/"+v.Name, func(t *testing.T) {
					p := write.Promotion{Name: "SK synthetic " + v.Name, Type: kind, IsActive: true,
						BundleConfig: &write.BundleConfigInput{BundlePrice: 50, Slots: []write.BundleSlotInput{{ProductKeys: v.Left, Quantity: 1}, {ProductKeys: v.Right, Quantity: 1}}},
						BXGYConfig:   &write.BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: v.Left, GetProductIDs: v.Right, GetDiscountKind: "percentage", GetDiscountValue: 100}}
					before := promotionsSnapshot()
					id, err := wr.CreatePromotion(ctx, p)
					if v.Overlap {
						if err == nil || promotionsSnapshot() != before {
							t.Fatal("invalid create wrote promotion/version")
						}
						if err = wr.UpdatePromotion(ctx, "00000000-0000-4000-8300-000000000004", p); err == nil || promotionsSnapshot() != before {
							t.Fatal("invalid update wrote promotion/version")
						}
					} else {
						if err != nil {
							t.Fatal(err)
						}
						if err = wr.UpdatePromotion(ctx, id, p); err != nil {
							t.Fatal(err)
						}
					}
				})
			}
		}
	})
	var fixture struct {
		Cases []struct {
			Name, Kind, PromotionID, Code string
			Item                          struct{ Payload json.RawMessage }
		}
	}
	raw, err := os.ReadFile("testdata/linked_fulfillment_orders.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	const buy = "00000000-0000-4000-8300-000000000001"
	const reward = "00000000-0000-4000-8300-000000000002"
	const outlet = "00000000-0000-4000-8300-000000000090"
	seq := 0
	for _, reverse := range []bool{false, true} {
		for _, c := range fixture.Cases {
			for _, mode := range []string{"online", "captured-offline"} {
				t.Run(fmt.Sprintf("%s/%s/reverse-%v", mode, c.Name, reverse), func(t *testing.T) {
					seq++
					left, right := []string{buy}, []string{buy + "|M", reward}
					if reverse {
						left, right = right, left
					}
					bx, _ := json.Marshal(map[string]any{"buyQuantity": 1, "getQuantity": 1, "buyProductIds": left, "getProductIds": right, "getDiscountKind": "percentage", "getDiscountValue": 50})
					bundle, _ := json.Marshal(map[string]any{"slots": []any{map[string]any{"productKeys": left, "quantity": 1}, map[string]any{"productKeys": right, "quantity": 1}}, "bundlePrice": 105000})
					// Deliberately seed a stale invalid rule via synthetic SQL, never a production migration.
					exec(`UPDATE promotions SET bxgy_config=$2::jsonb,bundle_config=$3::jsonb,code_only=$4 WHERE id=$1`, c.PromotionID, string(bx), string(bundle), c.Kind == "code")
					var payload map[string]any
					if err := json.Unmarshal(c.Item.Payload, &payload); err != nil {
						t.Fatal(err)
					}
					payload["orderUuid"] = fmt.Sprintf("00000000-0000-4000-8400-%012d", seq)
					// Captured reward price is deliberately different from current catalog pricing.
					var expected float64
					for _, v := range payload["items"].([]any) {
						item := v.(map[string]any)
						if item["isReward"] == true {
							item["price"] = float64(1234)
							item["subtotal"] = float64(1234)
						}
						expected += item["subtotal"].(float64)
					}
					payload["amountPaid"] = expected
					key := fmt.Sprintf("semantic-original-%d", seq)
					handler, path := direct, "/orders"
					var body any = payload
					if mode == "captured-offline" {
						handler, path = batch, "/sync/batch"
						body = map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": payload}}}
					}
					bodyBytes, _ := json.Marshal(body)
					request := func() *httptest.ResponseRecorder {
						r := httptest.NewRequest("POST", path, strings.NewReader(string(bodyBytes)))
						r.Header.Set("Authorization", "Bearer "+token)
						r.Header.Set("Idempotency-Key", key)
						w := httptest.NewRecorder()
						handler.ServeHTTP(w, r)
						return w
					}
					before := snapshot()
					var usageBefore int
					if err := pool.QueryRow(ctx, `SELECT usage_count FROM discount_codes WHERE code=$1`, c.Code).Scan(&usageBefore); err != nil {
						t.Fatal(err)
					}
					stocks := map[string]int{}
					for _, pid := range []string{buy, reward} {
						var n int
						if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outlet, pid).Scan(&n); err != nil {
							t.Fatal(err)
						}
						stocks[pid] = n
					}
					w := request()
					reason := "reward_invalid"
					if strings.HasPrefix(c.Name, "bundle") {
						reason = "bundle_invalid"
					}
					if mode == "online" {
						if w.Code != 422 || !strings.Contains(w.Body.String(), map[string]string{"bundle_invalid": "Bundel tidak valid", "reward_invalid": "Hadiah promo tidak valid"}[reason]) || snapshot() != before {
							t.Fatalf("invalid online mutation/status: %d %s", w.Code, w.Body.String())
						}
						t.Log("422; full financial/stock/grant/code/key snapshots unchanged")
						return
					}
					var result struct{ Data syncpkg.BatchResult }
					if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 || len(result.Data.Results) != 1 || result.Data.Results[0].Status != "ok" || result.Data.Results[0].IdempotencyKey != key {
						t.Fatalf("capture rejected: %d %s", w.Code, w.Body.String())
					}
					var orderID, warn string
					var total, paid float64
					var warning bool
					var codes []byte
					if err := pool.QueryRow(ctx, `SELECT id,total,amount_paid,discount_warning,discount_warning_reason,COALESCE(applied_discount_codes,'[]'::jsonb) FROM orders WHERE idempotency_key=$1`, key).Scan(&orderID, &total, &paid, &warning, &warn, &codes); err != nil {
						t.Fatal(err)
					}
					if total != expected || paid != expected || !warning || !strings.Contains(warn, reason) {
						t.Fatalf("captured price/review not retained: total=%v paid=%v warning=%v reason=%s", total, paid, warning, warn)
					}
					var qty, grants, usage int
					var price, sub float64
					if err := pool.QueryRow(ctx, `SELECT quantity,price,subtotal FROM order_items WHERE order_id=$1 AND product_id=$2`, orderID, reward).Scan(&qty, &price, &sub); err != nil {
						t.Fatal(err)
					}
					if qty != 1 || price != 1234 || sub != 1234 {
						t.Fatalf("physical fact changed: %d %v %v", qty, price, sub)
					}
					if err := pool.QueryRow(ctx, `SELECT count(*) FROM promo_reward_grants WHERE order_id=$1`, orderID).Scan(&grants); err != nil {
						t.Fatal(err)
					}
					if err := pool.QueryRow(ctx, `SELECT usage_count FROM discount_codes WHERE code=$1`, c.Code).Scan(&usage); err != nil {
						t.Fatal(err)
					}
					delta := 0
					if c.Kind == "code" {
						delta = 1
						var applied []string
						if json.Unmarshal(codes, &applied) != nil || len(applied) != 1 || applied[0] != c.Code {
							t.Fatal("raw provenance lost")
						}
					}
					if grants != 0 || usage != usageBefore+delta {
						t.Fatalf("invalid validated grant/usage grants=%d usage=%d", grants, usage)
					}
					for _, pid := range []string{buy, reward} {
						var n int
						if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outlet, pid).Scan(&n); err != nil || n != stocks[pid]-1 {
							t.Fatal("physical stock not retained once", err)
						}
					}
					committed := snapshot()
					retry := request()
					if retry.Code != 200 || snapshot() != committed {
						t.Fatal("original-key retry changed effects")
					}
					t.Logf("captured total=%v; two physical units; reward price1234 preserved; %s; no validated grant; usage delta%d once", total, reason, delta)
				})
			}
		}
	}
	t.Run("read-only-preflight", func(t *testing.T) {
		// Include an inactive row: preflight must not silently hide legacy configs.
		exec(`UPDATE promotions SET is_active=false WHERE id='00000000-0000-4000-8300-000000000004'`)
		before := snapshot() + promotionsSnapshot()
		report, err := promotionpreflight.Scan(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot()+promotionsSnapshot() != before {
			t.Fatal("diagnostic mutated data")
		}
		found := map[string]bool{}
		for _, f := range report.Findings {
			if f.Reason == "semantic_overlap" {
				found[f.ID] = true
			}
		}
		if !found["00000000-0000-4000-8300-000000000003"] || !found["00000000-0000-4000-8300-000000000004"] {
			t.Fatal("legacy overlaps missed", report)
		}
		out, _ := json.Marshal(report)
		t.Logf("read-only report: %s", out)
		if len(promotionkeys.Diagnose(promotionkeys.StoredPromotion{ID: "broken", Type: "bundle", BundleConfig: json.RawMessage(`{"slots":42}`)})) != 1 {
			t.Fatal("uninspectable config hidden")
		}
	})
}
