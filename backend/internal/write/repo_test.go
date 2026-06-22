package write

import "testing"

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
