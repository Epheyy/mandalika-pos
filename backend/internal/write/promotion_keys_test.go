package write

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestSemanticPromotionOverlapRegression(t *testing.T) {
	for _, pair := range [][2]string{{"P", "P|M"}, {"P|M", "P"}} {
		t.Run(pair[0]+"_"+pair[1], func(t *testing.T) {
			if err := validateBundle(&BundleConfigInput{BundlePrice: 10, Slots: []BundleSlotInput{{ProductKeys: []string{pair[0]}, Quantity: 1}, {ProductKeys: []string{pair[1]}, Quantity: 1}}}); err == nil {
				t.Error("semantic cross-slot overlap accepted")
			}
			if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: []string{pair[0]}, GetProductIDs: []string{pair[1]}, GetDiscountKind: "percentage", GetDiscountValue: 100}); err == nil {
				t.Error("semantic buy/get overlap accepted")
			}
		})
	}
}

func TestAuthoringSharedKeyVectors(t *testing.T) {
	var cases []struct {
		Name        string
		Left, Right []string
		Overlap     bool
	}
	raw, err := os.ReadFile("../promotionkeys/testdata/overlap.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			bx := &BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, BuyProductIDs: c.Left, GetProductIDs: c.Right, GetDiscountKind: "percentage", GetDiscountValue: 100}
			if (validateBXGY(bx) != nil) != c.Overlap {
				t.Fatal("BXGY contract disagreement")
			}
			// Empty bundle slots remain structurally invalid; empty buy/get has separate BXGY meaning.
			if len(c.Left) == 0 || len(c.Right) == 0 {
				return
			}
			bundle := &BundleConfigInput{BundlePrice: 50, Slots: []BundleSlotInput{{ProductKeys: c.Left, Quantity: 1}, {ProductKeys: c.Right, Quantity: 1}}}
			if (validateBundle(bundle) != nil) != c.Overlap {
				t.Fatal("bundle contract disagreement")
			}
			if !c.Overlap {
				return
			}
			for _, p := range []Promotion{{Type: "bundle", BundleConfig: bundle}, {Type: "buy_x_get_y", BXGYConfig: bx}} {
				// A nil pool intentionally proves rejection before any transaction is attempted.
				repo := &Repo{}
				if _, err := repo.CreatePromotion(context.Background(), p); err == nil {
					t.Fatal("Create accepted overlap")
				}
				if err := repo.UpdatePromotion(context.Background(), "unused", p); err == nil {
					t.Fatal("Update accepted overlap")
				}
			}
		})
	}
}
