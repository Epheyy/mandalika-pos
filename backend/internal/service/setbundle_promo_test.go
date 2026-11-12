package service

import (
	"reflect"
	"testing"
)

// bundleCart: bundle pieces (A 120ml, B 10ml, A 2ml, all InBundle) plus a single A 120ml.
func bundleCart() []LineItem {
	return []LineItem{
		{ProductID: "A", VariantSize: "120ml", Price: 675498, Quantity: 1, Subtotal: 675498, InBundle: true},
		{ProductID: "B", VariantSize: "10ml", Price: 140728, Quantity: 1, Subtotal: 140728, InBundle: true},
		{ProductID: "A", VariantSize: "2ml", Price: 33774, Quantity: 1, Subtotal: 33774, InBundle: true},
		{ProductID: "A", VariantSize: "120ml", Price: 1200000, Quantity: 1, Subtotal: 1200000},
	}
}

func TestComputeBundlePiecesIgnoredByProductKeyedPromos(t *testing.T) {
	cases := []struct {
		name  string
		promo PromoSpec
		want  float64
	}{
		{"scoped percent", PromoSpec{Kind: DiscountPercentage, Value: 10, ApplicableProductIDs: []string{"A"}}, 120000},
		{"scoped BOGO", PromoSpec{Kind: DiscountPercentage, IsBOGO: true, ApplicableProductIDs: []string{"A"}}, 0},
		{"unscoped BOGO", PromoSpec{Kind: DiscountPercentage, IsBOGO: true}, 0},
		{"BXGY same set", PromoSpec{Kind: DiscountBuyXGetY, BXGY: &BXGYConfig{
			BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}}, 0},
		{"unscoped percent sees the bundle", PromoSpec{Kind: DiscountPercentage, Value: 10}, 205000},
		{"tiered on the subtotal", PromoSpec{Kind: DiscountTiered, Tiered: &TieredConfig{
			Tiers: []Tier{{MinSubtotal: 2000000, Kind: DiscountFixed, Value: 100000}}}}, 100000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := Compute(PricingInput{Items: bundleCart(), Promos: []PromoSpec{c.promo}})
			if res.PromoDiscount != c.want {
				t.Fatalf("promo discount %v, want %v", res.PromoDiscount, c.want)
			}
		})
	}
}

func TestPromoEligibleLinesSkipsBundlePieces(t *testing.T) {
	items := bundleCart()
	scoped := &PromoSpec{Kind: DiscountPercentage, Value: 10, ApplicableProductIDs: []string{"A"}}
	if got := promoEligibleLines(scoped, items); !reflect.DeepEqual(got, []int{3}) {
		t.Errorf("scoped: %v", got)
	}
	bogo := &PromoSpec{Kind: DiscountPercentage, IsBOGO: true}
	if got := promoEligibleLines(bogo, items); !reflect.DeepEqual(got, []int{3}) {
		t.Errorf("unscoped BOGO: %v", got)
	}
	bxgy := &PromoSpec{Kind: DiscountBuyXGetY, BXGY: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1}}
	if got := promoEligibleLines(bxgy, items); !reflect.DeepEqual(got, []int{3}) {
		t.Errorf("BXGY empty keys: %v", got)
	}
	if got := promoEligibleLines(bogo, items[3:]); got != nil {
		t.Errorf("cart without pieces must stay nil, got %v", got)
	}
}

func TestRefundGroupsSetBundles(t *testing.T) {
	mk := func(g int) OrderItem {
		return OrderItem{ProductID: "A", Quantity: 1, BundleGroup: g, BundleRole: "large"}
	}
	items := []OrderItem{mk(1), mk(1), mk(1), mk(2), mk(2), mk(2), {ProductID: "A", Quantity: 1}}
	got := refundGroups(items)
	want := []string{"set:1", "set:1", "set:1", "set:2", "set:2", "set:2", ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestRefundGroupsPromoNeverAnchorsOnPiece(t *testing.T) {
	bxgy := &refundGroupInfo{kind: "bxgy", promoID: "p", bxgy: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, GetProductIDs: []string{"G"}}}
	items := []OrderItem{
		{ProductID: "A", Quantity: 1, BundleGroup: 1, BundleRole: "large"},
		{ProductID: "A", Quantity: 1},
		{ProductID: "G", Quantity: 1, IsReward: true, group: bxgy},
	}
	got := refundGroups(items)
	if got[0] != "set:1" || got[1] != "bxgy:p:1" || got[2] != "bxgy:p:1" {
		t.Fatalf("got %v", got)
	}
}

func TestPlanRefundSetBundleWholeOnly(t *testing.T) {
	mk := func() []refundLine {
		return []refundLine{
			{ID: "a", LineNo: ip(0), Net: i64(675498), Group: "set:1", Qty: 1},
			{ID: "b", LineNo: ip(1), Net: i64(140728), Group: "set:1", Qty: 1},
			{ID: "c", LineNo: ip(2), Net: i64(33774), Group: "set:1", Qty: 1},
		}
	}
	if _, _, err := planRefund(mk(), []RefundItemInput{{1, 1}}); err != ErrRefundGroupSplit {
		t.Fatalf("one piece: %v", err)
	}
	picks, _, err := planRefund(mk(), []RefundItemInput{{0, 1}, {1, 1}, {2, 1}})
	if err != nil {
		t.Fatal(err)
	}
	var sum int64
	for _, p := range picks {
		sum += p.Amount
	}
	if sum != 850000 {
		t.Fatalf("refund amount %d, want 850000", sum)
	}
}
