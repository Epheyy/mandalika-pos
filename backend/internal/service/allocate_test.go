package service

import (
	"encoding/json"
	"math/rand"
	"os"
	"reflect"
	"testing"
)

type allocGoldenCase struct {
	Name         string           `json:"name"`
	Lines        []AllocLine      `json:"lines"`
	Components   []AllocComponent `json:"components"`
	Total        int64            `json:"total"`
	OK           bool             `json:"ok"`
	ExpectedNets []int64          `json:"expectedNets"`
}

type refundGoldenCase struct {
	Name            string  `json:"name"`
	Net             int64   `json:"net"`
	Qty             int64   `json:"qty"`
	Steps           []int64 `json:"steps"`
	ExpectedAmounts []int64 `json:"expectedAmounts"`
}

func TestAllocateGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/allocate_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Allocations []allocGoldenCase  `json:"allocations"`
		Refunds     []refundGoldenCase `json:"refunds"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Allocations) == 0 || len(g.Refunds) == 0 {
		t.Fatal("golden file is empty")
	}
	for _, c := range g.Allocations {
		t.Run(c.Name, func(t *testing.T) {
			nets, ok := AllocateNet(AllocInput{Lines: c.Lines, Components: c.Components, Total: c.Total})
			if ok != c.OK {
				t.Fatalf("ok = %v, want %v (nets %v)", ok, c.OK, nets)
			}
			if !c.OK {
				return
			}
			if !reflect.DeepEqual(nets, c.ExpectedNets) {
				t.Fatalf("nets = %v, want %v", nets, c.ExpectedNets)
			}
			assertNetInvariants(t, nets, c.Total)
		})
	}
	for _, c := range g.Refunds {
		t.Run("refund "+c.Name, func(t *testing.T) {
			var prior int64
			for i, k := range c.Steps {
				got := RefundAmountForUnits(c.Net, c.Qty, prior, k)
				if got != c.ExpectedAmounts[i] {
					t.Fatalf("step %d: got %d want %d", i, got, c.ExpectedAmounts[i])
				}
				prior += k
			}
		})
	}
}

func assertNetInvariants(t *testing.T, nets []int64, total int64) {
	t.Helper()
	var sum int64
	for i, n := range nets {
		if n < 0 {
			t.Fatalf("net[%d] = %d is negative", i, n)
		}
		sum += n
	}
	if sum != total {
		t.Fatalf("sum(net) = %d, want total %d", sum, total)
	}
}

func TestAllocateNetInvalidInputs(t *testing.T) {
	cases := map[string]AllocInput{
		"no lines":       {Total: 0},
		"negative total": {Lines: []AllocLine{{LineNo: 0, Base: 10}}, Total: -1},
		"negative base":  {Lines: []AllocLine{{LineNo: 0, Base: -5}}, Total: 0},
		"bad eligible":   {Lines: []AllocLine{{LineNo: 0, Base: 10}}, Components: []AllocComponent{{Amount: 1, Eligible: []int{3}}}, Total: 9},
	}
	for name, in := range cases {
		if _, ok := AllocateNet(in); ok {
			t.Errorf("%s: expected ok=false", name)
		}
	}
}

func TestAllocateNetDeterministicAndInvariantRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 500; iter++ {
		n := 1 + rng.Intn(6)
		in := AllocInput{}
		var sub int64
		for i := 0; i < n; i++ {
			b := int64(rng.Intn(20)) * 5000
			if rng.Intn(5) == 0 {
				b = 0
			}
			in.Lines = append(in.Lines, AllocLine{LineNo: i, Base: b})
			sub += b
		}
		if sub == 0 {
			in.Lines[0].Base = 10000
			sub = 10000
		}
		disc := int64(rng.Intn(int(sub/1000)+1)) * 500
		if disc > sub {
			disc = sub
		}
		in.Components = []AllocComponent{{Amount: disc}}
		after := sub - disc
		if after == 0 {
			in.Components = nil
			after = sub
		}
		in.Total = after + int64(rng.Intn(5000)) - int64(rng.Intn(int(after)/2+1))
		a, ok := AllocateNet(in)
		if !ok {
			t.Fatalf("iter %d: unexpected failure for %+v", iter, in)
		}
		assertNetInvariants(t, a, in.Total)
		b, _ := AllocateNet(in)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("iter %d: not deterministic", iter)
		}
	}
}

func TestRefundCumSumsExactlyToNet(t *testing.T) {
	for _, tc := range []struct{ net, qty int64 }{{100000, 3}, {99999, 7}, {1, 5}, {7, 7}} {
		var total, prior int64
		for prior < tc.qty {
			total += RefundAmountForUnits(tc.net, tc.qty, prior, 1)
			prior++
		}
		if total != tc.net {
			t.Errorf("net %d qty %d: refunded %d", tc.net, tc.qty, total)
		}
	}
	if got := RefundCum(1_000_000_000_000, 2_000_000_000, 1_999_999_999); got <= 0 || got >= 1_000_000_000_000 {
		t.Errorf("large cum overflowed: %d", got)
	}
	if RefundCum(100, 3, 0) != 0 || RefundCum(100, 0, 1) != 0 {
		t.Error("cum must be 0 for n<=0 or qty<=0")
	}
}

func allocLI(pid, size string, price float64, qty int) LineItem {
	return LineItem{ProductID: pid, VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
}

func sumInt64(v []int64) (s int64) {
	for _, x := range v {
		s += x
	}
	return
}

// allocFromPricing runs the real Compute and the allocator over the same input, the way
// createOrderCore does (stored total = Compute total minus redeemed value).
func allocFromPricing(t *testing.T, in PricingInput, redeem float64) []int64 {
	t.Helper()
	total := Compute(in).Total - redeem
	items := make([]OrderItem, len(in.Items))
	for i := range items {
		items[i].payloadLine = i
	}
	lines, ok := allocateOrderLines(items, in, total)
	if !ok {
		t.Fatalf("allocation failed for %+v", in)
	}
	nets := make([]int64, len(lines))
	for i, l := range lines {
		nets[i] = l.net
	}
	assertNetInvariants(t, nets, int64(total))
	return nets
}

func TestAllocateFromPricingScenarios(t *testing.T) {
	items := []LineItem{allocLI("a", "50ml", 100000, 1), allocLI("b", "50ml", 50000, 2), allocLI("c", "10ml", 80000, 1)}
	t.Run("scoped percentage promo hits only its product", func(t *testing.T) {
		nets := allocFromPricing(t, PricingInput{Items: items, Promos: []PromoSpec{
			{Kind: DiscountPercentage, Value: 10, ApplicableProductIDs: []string{"a"}}}}, 0)
		if !reflect.DeepEqual(nets, []int64{90000, 100000, 80000}) {
			t.Fatalf("nets %v", nets)
		}
	})
	t.Run("tiered spreads over every line", func(t *testing.T) {
		nets := allocFromPricing(t, PricingInput{Items: items, Promos: []PromoSpec{
			{Kind: DiscountTiered, Tiered: &TieredConfig{Tiers: []Tier{{MinSubtotal: 200000, Kind: DiscountPercentage, Value: 10}}}}}}, 0)
		if !reflect.DeepEqual(nets, []int64{90000, 90000, 72000}) { // 280000 - 28000
			t.Fatalf("nets %v", nets)
		}
	})
	t.Run("bxgy same-set discounts counted lines only", func(t *testing.T) {
		in := PricingInput{Items: []LineItem{allocLI("a", "", 100000, 1), allocLI("b", "", 50000, 1), allocLI("z", "", 70000, 1)}, Promos: []PromoSpec{
			{Kind: DiscountBuyXGetY, BXGY: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a", "b"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}}}}
		nets := allocFromPricing(t, in, 0)
		// the cheapest buy-set unit (b, 50000) is free; spread over lines a and b only
		if nets[2] != 70000 || sumInt64(nets) != 170000 {
			t.Fatalf("nets %v", nets)
		}
	})
	t.Run("stacked codes manual percent tax surcharge rounding and redeem", func(t *testing.T) {
		in := PricingInput{
			Items: items, ManualDiscount: 5, ManualKind: DiscountPercentage,
			Surcharge: 2000, SurchargeKind: DiscountFixed, TaxEnabled: true, TaxRate: 11,
			RoundingEnabled: true, RoundingType: "nearest_1000",
			Promos: []PromoSpec{
				{Kind: DiscountFixed, Value: 10000, ApplicableProductIDs: []string{"b"}},
				{Kind: DiscountPercentage, Value: 10},
			},
		}
		if nets := allocFromPricing(t, in, 7000); len(nets) != 3 {
			t.Fatal(nets)
		}
	})
	t.Run("zero priced loyalty reward line stays zero", func(t *testing.T) {
		in := PricingInput{Items: []LineItem{allocLI("a", "", 100000, 1), {ProductID: "r", Quantity: 1}}, TaxEnabled: true, TaxRate: 11}
		nets := allocFromPricing(t, in, 0)
		if nets[1] != 0 || nets[0] != 111000 {
			t.Fatalf("nets %v", nets)
		}
	})
	t.Run("fractional total skips allocation", func(t *testing.T) {
		in := PricingInput{Items: []LineItem{allocLI("a", "", 100000, 1)}}
		if _, ok := allocateOrderLines([]OrderItem{{payloadLine: 0}}, in, 99999.5); ok {
			t.Fatal("expected skip for non-whole-rupiah total")
		}
	})
	t.Run("manual plus promo capped at subtotal", func(t *testing.T) {
		in := PricingInput{Items: []LineItem{allocLI("a", "", 10000, 1)}, ManualDiscount: 50000, ManualKind: DiscountFixed,
			Promos: []PromoSpec{{Kind: DiscountFixed, Value: 50000}}}
		if Compute(in).Total != 0 {
			t.Fatalf("total %v", Compute(in).Total)
		}
		if nets := allocFromPricing(t, in, 0); nets[0] != 0 {
			t.Fatalf("nets %v", nets)
		}
	})
}

func TestAllocateOrderLinesLineNoSurvivesCompaction(t *testing.T) {
	// payload index 1 was dropped by reward resolution: kept lines keep indices 0 and 2.
	in := PricingInput{Items: []LineItem{allocLI("a", "", 100, 1), allocLI("b", "", 100, 1)}}
	lines, ok := allocateOrderLines([]OrderItem{{payloadLine: 0}, {payloadLine: 2}}, in, 200)
	if !ok || lines[0].lineNo != 0 || lines[1].lineNo != 2 {
		t.Fatalf("%v %v", lines, ok)
	}
	if _, ok := allocateOrderLines([]OrderItem{{payloadLine: 1}, {payloadLine: 1}}, in, 200); ok {
		t.Fatal("duplicate line index must skip allocation")
	}
	if _, ok := allocateOrderLines([]OrderItem{{payloadLine: 0}, {payloadLine: maxLineNo + 1}}, in, 200); ok {
		t.Fatal("line index beyond smallint must skip allocation")
	}
}

func TestRefundGroups(t *testing.T) {
	bundle := &refundGroupInfo{kind: "bundle", promoID: "P1", bundle: &BundleConfig{Slots: []BundleSlot{
		{ProductKeys: []string{"a"}, Quantity: 1}, {ProductKeys: []string{"b|50ml"}, Quantity: 1}}}}
	bx := &refundGroupInfo{kind: "bxgy", promoID: "P2", bxgy: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"x"}, GetProductIDs: []string{"y"}}}
	items := []OrderItem{
		{ProductID: "a", VariantSize: "50ml"},                                // 0 bundle anchor
		{ProductID: "b", VariantSize: "50ml", IsReward: true, group: bundle}, // 1 bundle freed
		{ProductID: "b", VariantSize: "100ml"},                               // 2 other variant: not in the bundle
		{ProductID: "x", VariantSize: "50ml"},                                // 3 bxgy buy
		{ProductID: "y", VariantSize: "50ml", IsReward: true, group: bx},     // 4 bxgy reward
		{ProductID: "r", VariantSize: "50ml", IsReward: true},                // 5 loyalty reward: independent
		{ProductID: "z", VariantSize: "50ml"},                                // 6 unrelated
	}
	want := []string{"bundle:P1:1", "bundle:P1:1", "", "bxgy:P2:1", "bxgy:P2:1", "", ""}
	if got := refundGroups(items); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if g := refundGroups([]OrderItem{{ProductID: "a"}}); g[0] != "" {
		t.Fatal("no reward line, no group")
	}
}

func TestDiscountComponentsDoesNotChangeCompute(t *testing.T) {
	in := PricingInput{Items: []LineItem{allocLI("a", "", 100000, 2)}, Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 10}}}
	before := Compute(in)
	if c := DiscountComponents(in); len(c) != 1 || c[0].Amount != 20000 || c[0].Eligible != nil {
		t.Fatalf("components %+v", c)
	}
	if after := Compute(in); after != before {
		t.Fatalf("Compute changed: %+v vs %+v", before, after)
	}
}

func TestRefundGroupsMergeSharedAnchor(t *testing.T) {
	p1 := &refundGroupInfo{kind: "bxgy", promoID: "P1", bxgy: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, GetProductIDs: []string{"x"}}}
	p2 := &refundGroupInfo{kind: "bxgy", promoID: "P2", bxgy: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, GetProductIDs: []string{"y"}}}
	items := []OrderItem{
		{ProductID: "a", VariantSize: "50ml"},
		{ProductID: "x", VariantSize: "50ml", IsReward: true, group: p1},
		{ProductID: "y", VariantSize: "50ml", IsReward: true, group: p2},
		{ProductID: "z", VariantSize: "50ml", IsReward: true}, // loyalty reward stays independent
	}
	// 'a' is an anchor of both promos (empty buy list), so both groups collapse into one.
	want := []string{"bxgy:P1:1", "bxgy:P1:1", "bxgy:P1:1", ""}
	if got := refundGroups(items); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// Reversing the reward order must not change the merged key (smallest key wins).
	rev := []OrderItem{items[0], items[2], items[1], items[3]}
	want = []string{"bxgy:P1:1", "bxgy:P1:1", "bxgy:P1:1", ""}
	if got := refundGroups(rev); !reflect.DeepEqual(got, want) {
		t.Fatalf("reordered: got %v want %v", got, want)
	}
}

func TestRefundGroupsMergeBundleSlotAndBxgyBuySet(t *testing.T) {
	bundle := &refundGroupInfo{kind: "bundle", promoID: "P9", bundle: &BundleConfig{Slots: []BundleSlot{
		{ProductKeys: []string{"a"}, Quantity: 1}, {ProductKeys: []string{"b"}, Quantity: 1}}}}
	bx := &refundGroupInfo{kind: "bxgy", promoID: "P2", bxgy: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a"}, GetProductIDs: []string{"y"}}}
	items := []OrderItem{
		{ProductID: "a"}, // anchor of the bundle slot AND the BXGY buy set
		{ProductID: "b", IsReward: true, group: bundle},
		{ProductID: "y", IsReward: true, group: bx},
		{ProductID: "q"}, // unrelated
	}
	want := []string{"bundle:P9:1", "bundle:P9:1", "bundle:P9:1", ""}
	if got := refundGroups(items); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Drift guard: DiscountComponents must keep tracking calcPromotionDiscount and Compute.
func TestDiscountComponentsTrackEngine(t *testing.T) {
	base := []LineItem{allocLI("a", "50ml", 100000, 2), allocLI("b", "50ml", 60000, 1), allocLI("c", "10ml", 45000, 3)}
	tiered := PromoSpec{Kind: DiscountTiered, Tiered: &TieredConfig{Tiers: []Tier{
		{MinSubtotal: 100000, Kind: DiscountPercentage, Value: 5}, {MinSubtotal: 300000, Kind: DiscountFixed, Value: 30000}}}}
	bxgy := PromoSpec{Kind: DiscountBuyXGetY, BXGY: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a", "c|10ml"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 50}}
	bxgySep := PromoSpec{Kind: DiscountBuyXGetY, BXGY: &BXGYConfig{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{"a"}, GetProductIDs: []string{"b"}, GetDiscountKind: DiscountPercentage, GetDiscountValue: 100}}
	cases := map[string]PricingInput{
		"unscoped percentage":    {Items: base, Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 10}}},
		"scoped percentage":      {Items: base, Promos: []PromoSpec{{Kind: DiscountPercentage, Value: 10, ApplicableProductIDs: []string{"a", "c"}}}},
		"scoped fixed":           {Items: base, Promos: []PromoSpec{{Kind: DiscountFixed, Value: 15000, ApplicableProductIDs: []string{"b"}}}},
		"scoped bogo":            {Items: base, Promos: []PromoSpec{{Kind: DiscountPercentage, IsBOGO: true, ApplicableProductIDs: []string{"c"}}}},
		"tiered":                 {Items: base, Promos: []PromoSpec{tiered}},
		"bxgy same-set":          {Items: base, Promos: []PromoSpec{bxgy}},
		"bxgy separate-set is 0": {Items: base, Promos: []PromoSpec{bxgySep}},
		"manual percent":         {Items: base, ManualDiscount: 7, ManualKind: DiscountPercentage},
		"manual fixed":           {Items: base, ManualDiscount: 25000, ManualKind: DiscountFixed},
		"stacked":                {Items: base, ManualDiscount: 5, ManualKind: DiscountPercentage, Promos: []PromoSpec{tiered, bxgy, {Kind: DiscountFixed, Value: 20000, ApplicableProductIDs: []string{"a"}}}},
		"capped at subtotal":     {Items: base[:1], ManualDiscount: 500000, ManualKind: DiscountFixed, Promos: []PromoSpec{{Kind: DiscountFixed, Value: 500000}}},
		"no discount":            {Items: base},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			comps := DiscountComponents(in)
			var sum int64
			for _, c := range comps {
				sum += c.Amount
			}
			res := Compute(in)
			if sum != roundRupiah(res.DiscountAmount) {
				t.Fatalf("components sum %d != Compute discount %v (%+v)", sum, res.DiscountAmount, comps)
			}
			if res.PromoDiscount+res.ManualDiscount <= res.Subtotal { // uncapped: amounts match one-for-one
				var want []int64
				for i := range in.Promos {
					if a := calcPromotionDiscount(&in.Promos[i], in.Items, res.Subtotal); a > 0 {
						want = append(want, roundRupiah(a))
					}
				}
				if res.ManualDiscount > 0 {
					want = append(want, roundRupiah(res.ManualDiscount))
				}
				var got []int64
				for _, c := range comps {
					got = append(got, c.Amount)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("component amounts %v, want %v", got, want)
				}
			}
		})
	}
}
