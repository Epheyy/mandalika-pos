package write

import (
	"strings"
	"testing"
)

func TestRandSuffix(t *testing.T) {
	const bad = "O01I"
	for i := 0; i < 200; i++ {
		s := randSuffix(8)
		if len(s) != 8 {
			t.Fatalf("len: want 8, got %d (%q)", len(s), s)
		}
		for _, c := range s {
			if strings.ContainsRune(bad, c) {
				t.Fatalf("ambiguous char %q in %q", c, s)
			}
			if !strings.ContainsRune("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", c) {
				t.Fatalf("unexpected char %q in %q", c, s)
			}
		}
	}
}

func TestValidateDiscountCodeBatch(t *testing.T) {
	ok := DiscountCodeBatch{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 6}
	if err := validateDiscountCodeBatch(ok); err != nil {
		t.Fatalf("valid rejected: %v", err)
	}
	bad := []DiscountCodeBatch{
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 0, SuffixLength: 6},                                // count<1
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 501, SuffixLength: 6},                              // count>500
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 3},                               // suffix<4
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 13},                              // suffix>12
		{DiscountCode: DiscountCode{Type: "bogus", Value: 10}, Count: 10, SuffixLength: 6},                                    // bad type
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 6, Prefix: "toolongprefixxxxx!"}, // prefix invalid
	}
	for i, b := range bad {
		if err := validateDiscountCodeBatch(b); err == nil {
			t.Fatalf("case %d: expected error", i)
		}
	}
}

func TestVariantBarcode(t *testing.T) {
	tests := []struct {
		name string
		v    Variant
		want string
	}{
		{"explicit barcode wins", Variant{SKU: "SK-1", Barcode: "8991234567890"}, "8991234567890"},
		{"empty barcode defaults to sku", Variant{SKU: "SK-1", Barcode: ""}, "SK-1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := variantBarcode(tt.v); got != tt.want {
				t.Fatalf("variantBarcode(%+v) = %q, want %q", tt.v, got, tt.want)
			}
		})
	}
}

func TestValidateVariants(t *testing.T) {
	tests := []struct {
		name    string
		vs      []Variant
		wantErr bool
	}{
		{
			name:    "valid: distinct sku and barcode",
			vs:      []Variant{{SKU: "A", Barcode: "111"}, {SKU: "B", Barcode: "222"}},
			wantErr: false,
		},
		{
			name:    "valid: empty barcodes default to distinct skus",
			vs:      []Variant{{SKU: "A"}, {SKU: "B"}},
			wantErr: false,
		},
		{
			name:    "invalid: missing sku",
			vs:      []Variant{{SKU: "", Barcode: "111"}},
			wantErr: true,
		},
		{
			name:    "invalid: duplicate sku",
			vs:      []Variant{{SKU: "A", Barcode: "111"}, {SKU: "A", Barcode: "222"}},
			wantErr: true,
		},
		{
			name:    "invalid: duplicate explicit barcode",
			vs:      []Variant{{SKU: "A", Barcode: "111"}, {SKU: "B", Barcode: "111"}},
			wantErr: true,
		},
		{
			name:    "invalid: explicit barcode collides with another variant's sku default",
			vs:      []Variant{{SKU: "A"}, {SKU: "B", Barcode: "A"}},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVariants(tt.vs)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateVariants(%+v) error = %v, wantErr %v", tt.vs, err, tt.wantErr)
			}
		})
	}
}

func TestValidateBXGYRejectsBadQuantities(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 0, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 100}); err == nil {
		t.Fatal("buyQuantity 0 must be rejected")
	}
}
func TestValidateBXGYRejectsPercentOver100(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 150}); err == nil {
		t.Fatal("percentage 150 must be rejected")
	}
}
func TestValidateBXGYRejectsFixedNonPositive(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "fixed", GetDiscountValue: 0}); err == nil {
		t.Fatal("fixed value 0 must be rejected")
	}
}
func TestValidateBXGYRejectsUnknownKind(t *testing.T) {
	if err := validateBXGY(&BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "bogo", GetDiscountValue: 1}); err == nil {
		t.Fatal("unknown getDiscountKind must be rejected")
	}
}
func TestValidateBXGYRejectsOverlap(t *testing.T) {
	c := &BXGYConfigInput{BuyQuantity: 1, GetQuantity: 1, GetDiscountKind: "fixed", GetDiscountValue: 1000,
		BuyProductIDs: []string{"a"}, GetProductIDs: []string{"a"}}
	if err := validateBXGY(c); err == nil {
		t.Fatal("overlapping buy/get sets must be rejected")
	}
}
func TestValidateBXGYAcceptsValidSameSet(t *testing.T) {
	// same-set: empty getProductIds, no overlap rule triggered
	c := &BXGYConfigInput{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 100,
		BuyProductIDs: []string{"a"}}
	if err := validateBXGY(c); err != nil {
		t.Fatalf("valid same-set rejected: %v", err)
	}
}
func TestValidateBXGYAcceptsValidSeparate(t *testing.T) {
	c := &BXGYConfigInput{BuyQuantity: 2, GetQuantity: 1, GetDiscountKind: "percentage", GetDiscountValue: 100,
		BuyProductIDs: []string{"a"}, GetProductIDs: []string{"b"}}
	if err := validateBXGY(c); err != nil {
		t.Fatalf("valid separate rejected: %v", err)
	}
}
func TestValidateBXGYNilRejected(t *testing.T) {
	if err := validateBXGY(nil); err == nil {
		t.Fatal("nil config must be rejected")
	}
}

func TestValidateTieredRejectsEmpty(t *testing.T) {
	if validateTiered(&TieredConfigInput{Tiers: nil}) == nil {
		t.Fatal("empty tiers must be rejected")
	}
}
func TestValidateTieredRejectsBadValue(t *testing.T) {
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: 100000, Kind: "percentage", Value: 150}}}) == nil {
		t.Fatal("percentage 150 must be rejected")
	}
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: 0, Kind: "fixed", Value: 0}}}) == nil {
		t.Fatal("fixed 0 must be rejected")
	}
	if validateTiered(&TieredConfigInput{Tiers: []TierInput{{MinSubtotal: -1, Kind: "fixed", Value: 1000}}}) == nil {
		t.Fatal("negative minSubtotal must be rejected")
	}
}
func TestValidateTieredRejectsDuplicateThreshold(t *testing.T) {
	c := &TieredConfigInput{Tiers: []TierInput{
		{MinSubtotal: 100000, Kind: "fixed", Value: 1000},
		{MinSubtotal: 100000, Kind: "percentage", Value: 10},
	}}
	if validateTiered(c) == nil {
		t.Fatal("duplicate minSubtotal must be rejected")
	}
}
func TestValidateTieredAccepts(t *testing.T) {
	c := &TieredConfigInput{Tiers: []TierInput{
		{MinSubtotal: 100000, Kind: "fixed", Value: 10000},
		{MinSubtotal: 250000, Kind: "percentage", Value: 15},
	}}
	if err := validateTiered(c); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestValidateBundle(t *testing.T) {
	ok := &BundleConfigInput{
		Slots: []BundleSlotInput{
			{ProductKeys: []string{"p110"}, Quantity: 1},
			{ProductKeys: []string{"atomA", "atomB"}, Quantity: 1},
		},
		BundlePrice: 575000, MaxApplications: 0,
	}
	if err := validateBundle(ok); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	cases := []*BundleConfigInput{
		nil,
		{Slots: nil, BundlePrice: 1}, // empty slots
		{Slots: []BundleSlotInput{{ProductKeys: nil, Quantity: 1}}, BundlePrice: 1},           // empty keys
		{Slots: []BundleSlotInput{{ProductKeys: []string{"p"}, Quantity: 0}}, BundlePrice: 1}, // qty<1
		{Slots: []BundleSlotInput{{ProductKeys: []string{"p"}, Quantity: 1}}, BundlePrice: 0}, // price<=0
		{Slots: []BundleSlotInput{ // overlapping key across slots
			{ProductKeys: []string{"p", "q"}, Quantity: 1},
			{ProductKeys: []string{"q"}, Quantity: 1},
		}, BundlePrice: 1},
	}
	for i, c := range cases {
		if err := validateBundle(c); err == nil {
			t.Fatalf("case %d: expected error, got nil", i)
		}
	}
}
