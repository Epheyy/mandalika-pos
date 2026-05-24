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
