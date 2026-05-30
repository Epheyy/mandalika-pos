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
			"happy warehouse→warehouse",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "warehouse", ID: "src"},
				Dest:   TransferLoc{Kind: "warehouse", ID: "dst"},
				Items:  []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1.5}},
			},
			true,
		},
		{
			"happy outlet→warehouse",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "outlet", ID: "outlet1"},
				Dest:   TransferLoc{Kind: "warehouse", ID: "wh1"},
				Items:  []IngredientTransferItemInput{{IngredientID: "i1", Qty: 2}},
			},
			true,
		},
		{
			"same src/dst",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "warehouse", ID: "a"},
				Dest:   TransferLoc{Kind: "warehouse", ID: "a"},
				Items:  []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1}},
			},
			false,
		},
		{
			"empty items",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "warehouse", ID: "src"},
				Dest:   TransferLoc{Kind: "outlet", ID: "dst"},
			},
			false,
		},
		{
			"zero qty",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "warehouse", ID: "src"},
				Dest:   TransferLoc{Kind: "outlet", ID: "dst"},
				Items:  []IngredientTransferItemInput{{IngredientID: "i1", Qty: 0}},
			},
			false,
		},
		{
			"bad source kind",
			IngredientTransferCreate{
				Source: TransferLoc{Kind: "shelf", ID: "s1"},
				Dest:   TransferLoc{Kind: "warehouse", ID: "d1"},
				Items:  []IngredientTransferItemInput{{IngredientID: "i1", Qty: 1}},
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
