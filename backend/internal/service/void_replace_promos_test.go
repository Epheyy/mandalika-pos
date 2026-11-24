package service

import (
	"reflect"
	"testing"
)

func TestMarkRewardLines(t *testing.T) {
	const promo = "p1"
	item := func(product string, qty int, price float64) OrderItem {
		return OrderItem{ProductID: product, VariantSize: "std", Quantity: qty, Price: price, Subtotal: price * float64(qty)}
	}
	grant := func(product string, units int) rewardGrantUnits {
		return rewardGrantUnits{PromotionID: promo, ProductID: product, VariantSize: "std", Units: units}
	}
	flagged := func(items []OrderItem) []bool {
		out := make([]bool, len(items))
		for i, it := range items {
			out[i] = it.IsReward && it.RewardPromotionID == promo
		}
		return out
	}

	t.Run("flags the cheaper line of the same product, not the paid anchor", func(t *testing.T) {
		items := []OrderItem{item("X", 2, 100000), item("X", 1, 0)}
		got, unrecovered := markRewardLines(items, []string{"bxgy:p1:1", "bxgy:p1:1"}, []rewardGrantUnits{grant("X", 1)})
		if len(unrecovered) != 0 || !reflect.DeepEqual(flagged(got), []bool{false, true}) {
			t.Fatalf("flagged %v unrecovered %v", flagged(got), unrecovered)
		}
		if items[1].IsReward {
			t.Fatal("the caller's slice was mutated")
		}
	})

	t.Run("a line outside the promotion group is never flagged", func(t *testing.T) {
		items := []OrderItem{item("X", 1, 0), item("X", 1, 0)}
		got, unrecovered := markRewardLines(items, []string{"", "bxgy:p1:1"}, []rewardGrantUnits{grant("X", 1)})
		if len(unrecovered) != 0 || !reflect.DeepEqual(flagged(got), []bool{false, true}) {
			t.Fatalf("flagged %v unrecovered %v", flagged(got), unrecovered)
		}
	})

	t.Run("bundle-freed lines are found through the bundle group", func(t *testing.T) {
		items := []OrderItem{item("X", 1, 80000)}
		got, unrecovered := markRewardLines(items, []string{"bundle:p1:1"}, []rewardGrantUnits{grant("X", 1)})
		if len(unrecovered) != 0 || !flagged(got)[0] {
			t.Fatalf("flagged %v unrecovered %v", flagged(got), unrecovered)
		}
	})

	t.Run("a grant that cannot be covered exactly is reported and leaves the lines plain", func(t *testing.T) {
		items := []OrderItem{item("X", 3, 0)} // one line of 3 cannot be split to cover 2 units
		got, unrecovered := markRewardLines(items, []string{"bxgy:p1:1"}, []rewardGrantUnits{grant("X", 2)})
		if len(unrecovered) != 1 || flagged(got)[0] {
			t.Fatalf("flagged %v unrecovered %v", flagged(got), unrecovered)
		}
	})

	t.Run("several reward lines cover a grant of several units", func(t *testing.T) {
		items := []OrderItem{item("X", 1, 0), item("X", 2, 0)}
		got, unrecovered := markRewardLines(items, []string{"bxgy:p1:1", "bxgy:p1:1"}, []rewardGrantUnits{grant("X", 3)})
		if len(unrecovered) != 0 || !reflect.DeepEqual(flagged(got), []bool{true, true}) {
			t.Fatalf("flagged %v unrecovered %v", flagged(got), unrecovered)
		}
	})
}

func TestBreakdownLabels(t *testing.T) {
	raw := []byte(`[{"label":"Diskon Manual","kind":"fixed","value":2000,"amount":2000},
	  {"label":"Promo 10","kind":"percentage","value":10,"amount":30000},
	  {"label":"HEMAT","kind":"fixed","value":5000,"amount":5000},
	  {"label":"Gratis","kind":"buy_x_get_y","value":0,"amount":0}]`)
	got := breakdownLabels(raw, []string{"HEMAT"})
	if !reflect.DeepEqual(got, []string{"Promo 10"}) {
		t.Fatalf("labels = %v, want only the promotion that took money off", got)
	}
	for _, bad := range [][]byte{nil, []byte(`null`), []byte(`{"a":1}`), []byte(`not json`)} {
		if got := breakdownLabels(bad, nil); len(got) != 0 {
			t.Fatalf("%q -> %v, want none", bad, got)
		}
	}
}

// A10: new optional stamps on breakdown rows must not disturb label recovery.
func TestBreakdownLabelsIgnoreVersionStamps(t *testing.T) {
	raw := []byte(`[{"label":"Sale 10","kind":"percentage","value":10,"amount":10000,"promotionId":"p1","promotionVersion":3},
		{"label":"HEMAT","kind":"fixed","value":5000,"amount":5000,"codeVersion":2}]`)
	got := breakdownLabels(raw, []string{"HEMAT"})
	if len(got) != 1 || got[0] != "Sale 10" {
		t.Fatalf("breakdownLabels = %v, want [Sale 10]", got)
	}
}
