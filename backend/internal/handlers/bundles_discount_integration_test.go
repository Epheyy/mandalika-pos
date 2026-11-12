package handlers

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/bundles"
	"github.com/mandalika/pos-backend/internal/write"
)

// Bundles phase 4 (Diskon Bundle): the discount reaches the order through the real sync path.
// Called from bundleSaleSubtests, which owns the fixture (bundle price EXT 120ml = 850000,
// basis [1200000, 250000, 60000]).
func bundleDiscountSubtests(
	t *testing.T, pool *pgxpool.Pool, ctx context.Context, wr *write.Repo,
	str func(string, ...any) string, exec func(string, ...any),
	bundleItems func(string, float64, float64) []map[string]any,
	sale func([]map[string]any, float64) map[string]any,
	syncSale func(map[string]any) map[string]any,
	orderID func(map[string]any) string,
	champ, extFull string,
) {
	exec(`UPDATE promotions SET is_active=false`) // earlier subtests left promotions; only the ones a sale lists apply
	yes := true
	promo := func(name, typ string, value float64, cfg *write.BundleDiscountConfigInput) string {
		t.Helper()
		id, err := wr.CreatePromotion(ctx, write.Promotion{Name: name, Type: typ, Value: value, IsActive: true, Combinable: &yes, BundleDiscountConfig: cfg})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	extCfg := func(kind string) *write.BundleDiscountConfigInput {
		return &write.BundleDiscountConfigInput{Kind: kind, Lines: []string{"EXTRAIT DE PARFUM"}, Sizes: []string{"120ml"}}
	}
	discSale := func(promoIDs []string, customerID string, total float64) map[string]any {
		t.Helper()
		p := sale(bundleItems(champ, 250000, 850000), total)
		p["promotionIds"] = promoIDs
		if customerID != "" {
			p["customerId"] = customerID
		}
		syncSale(p)
		return p
	}
	pieceCols := func(oid string) (prices, discs, promos [3]string) {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT price::text, COALESCE(bundle_discount::text,''), COALESCE(bundle_promotion_id::text,'')
		  FROM order_items WHERE order_id=$1 ORDER BY line_no`, oid)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		i := 0
		for rows.Next() {
			if i > 2 {
				t.Fatal("more than 3 piece rows")
			}
			if err := rows.Scan(&prices[i], &discs[i], &promos[i]); err != nil {
				t.Fatal(err)
			}
			i++
		}
		if i != 3 {
			t.Fatalf("piece rows = %d", i)
		}
		return
	}
	order := func(oid string) (subtotal, discount, total string) {
		t.Helper()
		return str(`SELECT subtotal::text FROM orders WHERE id=$1`, oid),
			str(`SELECT discount_amount::text FROM orders WHERE id=$1`, oid),
			str(`SELECT total::text FROM orders WHERE id=$1`, oid)
	}
	basis := [3]int64{1200000, 250000, 60000}

	t.Run("diskon_bundle_sale", func(t *testing.T) {
		id := promo("BN Diskon 10%", "bundle_discount", 10, extCfg("percentage"))
		wantNet, _ := bundles.Split(765000, basis)
		wantDisc, _ := bundles.Split(85000, basis)
		if wantNet != [3]int64{607948, 126655, 30397} || wantDisc != [3]int64{67551, 14072, 3377} {
			t.Fatalf("split drifted: net %v disc %v", wantNet, wantDisc)
		}
		oid := orderID(discSale([]string{id}, "", 765000))
		prices, discs, promos := pieceCols(oid)
		if prices != [3]string{"607948.00", "126655.00", "30397.00"} ||
			discs != [3]string{"67551.00", "14072.00", "3377.00"} || promos != [3]string{id, id, id} {
			t.Errorf("prices %v discounts %v promotions %v", prices, discs, promos)
		}
		if _, _, total := order(oid); total != "765000.00" {
			t.Errorf("total = %s, want 765000.00", total)
		}
	})

	t.Run("diskon_bundle_bigger_wins", func(t *testing.T) {
		pct := promo("BN Diskon 10% b", "bundle_discount", 10, extCfg("percentage"))
		fixed := promo("BN Diskon Rp100000", "bundle_discount", 100000, extCfg("fixed"))
		oid := orderID(discSale([]string{pct, fixed}, "", 750000))
		_, _, promos := pieceCols(oid)
		if promos != [3]string{fixed, fixed, fixed} {
			t.Errorf("promotions %v, want the Rp100000 one (%s)", promos, fixed)
		}
		if _, _, total := order(oid); total != "750000.00" {
			t.Errorf("total = %s, want 750000.00", total)
		}
	})

	t.Run("diskon_bundle_with_cart_pct", func(t *testing.T) {
		bd := promo("BN Diskon 10% c", "bundle_discount", 10, extCfg("percentage"))
		cart := promo("BN cart 10%", "percentage", 10, nil)
		oid := orderID(discSale([]string{bd, cart}, "", 688500))
		subtotal, discount, total := order(oid)
		if subtotal != "765000.00" || discount != "76500.00" || total != "688500.00" {
			t.Errorf("subtotal %s discount %s total %s, want 765000.00 76500.00 688500.00", subtotal, discount, total)
		}
	})

	t.Run("diskon_bundle_points_on_paid", func(t *testing.T) {
		const cust = "00000000-0000-4000-8f00-0000000000e1"
		defer exec(`UPDATE loyalty_settings SET enabled=false, points_per_thousand=0 WHERE id=1`)
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1, redemption_rate=100 WHERE id=1`)
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'BN Loyal','+62811000000',0)`, cust)
		bd := promo("BN Diskon 10% d", "bundle_discount", 10, extCfg("percentage"))
		oid := orderID(discSale([]string{bd}, cust, 765000))
		if got := str(`SELECT points_earned::text FROM orders WHERE id=$1`, oid); got != "765" {
			t.Errorf("points_earned = %s, want 765 (paid), not 850 (list)", got)
		}
		if got := str(`SELECT points::text FROM customers WHERE id=$1`, cust); got != "765" {
			t.Errorf("customer balance = %s, want 765", got)
		}
	})

	t.Run("loyalty_condition_ignores_bundle_pieces", func(t *testing.T) {
		const cust = "00000000-0000-4000-8f00-0000000000e2"
		defer exec(`DELETE FROM loyalty_conditions`)
		defer exec(`UPDATE loyalty_settings SET enabled=false, points_per_thousand=0 WHERE id=1`)
		exec(`UPDATE loyalty_settings SET enabled=true, points_per_thousand=1, redemption_rate=100 WHERE id=1`)
		exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'BN Loyal 2','+62811000001',0)`, cust)
		exec(`INSERT INTO loyalty_conditions(name,type,trigger,reward_type,reward_value,applicable_product_ids)
		      VALUES('BN buy big','always_on','product_purchase','set_points',500,$1::jsonb)`, `["`+champ+`|`+extFull+`"]`)
		// The large bottle only as a bundle piece: the condition must not fire (850000 list, no promotion: 850 base points).
		oid := orderID(discSale(nil, cust, 850000))
		if got := str(`SELECT points_earned::text FROM orders WHERE id=$1`, oid); got != "850" {
			t.Errorf("bundle sale points = %s, want 850 (no +500 from the condition)", got)
		}
		// The same bottle sold on its own still fires it.
		p := sale([]map[string]any{{"productId": champ, "productName": "CHAMPION", "variantSize": extFull, "price": 1200000, "quantity": 1, "subtotal": 1200000}}, 1200000)
		p["customerId"] = cust
		syncSale(p)
		if got := str(`SELECT points_earned::text FROM orders WHERE id=$1`, orderID(p)); got != "1700" {
			t.Errorf("plain sale points = %s, want 1700 (1200 + 500)", got)
		}
	})
}
