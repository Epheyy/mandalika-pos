package write

import "testing"

func TestValidateIngTransfer(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   IngredientTransferCreate
		ok   bool
	}{
		{
			"happy",
			IngredientTransferCreate{
				SourceWarehouseID: "src", DestWarehouseID: "dst",
				Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1.5}},
			},
			true,
		},
		{
			"same src/dst",
			IngredientTransferCreate{
				SourceWarehouseID: "a", DestWarehouseID: "a",
				Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1}},
			},
			false,
		},
		{
			"empty items",
			IngredientTransferCreate{
				SourceWarehouseID: "src", DestWarehouseID: "dst",
			},
			false,
		},
		{
			"zero qty",
			IngredientTransferCreate{
				SourceWarehouseID: "src", DestWarehouseID: "dst",
				Items: []IngredientTransferItemInput{{IngredientID: "i1", Qty: 0}},
			},
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateIngTransfer(tc.in)
			if tc.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}
