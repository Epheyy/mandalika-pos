package service

import (
	"encoding/json"
	"os"
	"testing"
)

type parityPromotion struct {
	ID                   string        `json:"id"`
	Type                 string        `json:"type"`
	Value                float64       `json:"value"`
	ApplicableProductIDs []string      `json:"applicableProductIds"`
	BXGYConfig           *BXGYConfig   `json:"bxgyConfig"`
	TieredConfig         *TieredConfig `json:"tieredConfig"`
	BundleConfig         *BundleConfig `json:"bundleConfig"`
}

type parityCase struct {
	Name string `json:"name"`
	Cart []struct {
		ProductID   string  `json:"productId"`
		VariantSize string  `json:"variantSize"`
		Price       float64 `json:"price"`
		Quantity    int     `json:"quantity"`
		Subtotal    float64 `json:"subtotal"`
		BundleGroup int     `json:"bundleGroup"`
	} `json:"cart"`
	Promotions []parityPromotion `json:"promotions"`
	Manual     struct {
		Type  string  `json:"type"`
		Value float64 `json:"value"`
	} `json:"manual"`
	Surcharge struct {
		Type  string  `json:"type"`
		Value float64 `json:"value"`
	} `json:"surcharge"`
	Settings struct {
		TaxEnabled      bool    `json:"taxEnabled"`
		TaxRate         float64 `json:"taxRate"`
		RoundingEnabled bool    `json:"roundingEnabled"`
		RoundingType    string  `json:"roundingType"`
	} `json:"settings"`
	Expected struct {
		PromoDiscount  float64 `json:"promoDiscount"`
		DiscountAmount float64 `json:"discountAmount"`
		TaxAmount      float64 `json:"taxAmount"`
		Total          float64 `json:"total"`
	} `json:"expected"`
}

// paritySpec mirrors loadPromoSpec (order.go): Kind, Value, ApplicableProductIDs,
// IsBOGO and the per-kind configs.
func paritySpec(p parityPromotion) PromoSpec {
	spec := PromoSpec{Kind: DiscountKind(p.Type), Value: p.Value, ApplicableProductIDs: p.ApplicableProductIDs, IsBOGO: p.Type == "bogo"}
	switch spec.Kind {
	case DiscountBuyXGetY:
		spec.BXGY = p.BXGYConfig
	case DiscountTiered:
		spec.Tiered = p.TieredConfig
	case DiscountBundle:
		spec.Bundle = p.BundleConfig
	}
	return spec
}

// Same fixture file is read by POS promoParity.test.ts. Engine code is never
// adjusted to make a vector pass.
func TestPromoParityGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/promo_parity_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []parityCase
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 26 {
		t.Fatal("golden fixture count changed", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			in := PricingInput{
				ManualDiscount: tc.Manual.Value, ManualKind: DiscountKind(tc.Manual.Type),
				Surcharge: tc.Surcharge.Value, SurchargeKind: DiscountKind(tc.Surcharge.Type),
				TaxEnabled: tc.Settings.TaxEnabled, TaxRate: tc.Settings.TaxRate,
				RoundingEnabled: tc.Settings.RoundingEnabled, RoundingType: tc.Settings.RoundingType,
			}
			for _, l := range tc.Cart {
				in.Items = append(in.Items, LineItem{ProductID: l.ProductID, VariantSize: l.VariantSize, Price: l.Price, Quantity: l.Quantity, Subtotal: l.Subtotal, InBundle: l.BundleGroup > 0})
			}
			for _, p := range tc.Promotions {
				in.Promos = append(in.Promos, paritySpec(p))
			}
			r := Compute(in)
			e := tc.Expected
			if r.PromoDiscount != e.PromoDiscount || r.DiscountAmount != e.DiscountAmount || r.TaxAmount != e.TaxAmount || r.Total != e.Total {
				t.Fatalf("got promo=%v discount=%v tax=%v total=%v want %+v", r.PromoDiscount, r.DiscountAmount, r.TaxAmount, r.Total, e)
			}
		})
	}
}
