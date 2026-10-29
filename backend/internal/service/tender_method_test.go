package service

import (
	"encoding/json"
	"errors"
	"testing"
)

// Reserved-id and printable-method rules (C6a review fixes): the structural check must catch
// everything Postgres' CHECK / text rules would otherwise trip on inside the transaction.
func TestStructuralMethodRules(t *testing.T) {
	for _, tc := range []struct {
		name    string
		method  string
		tenders string
		reject  bool
	}{
		{"split lower", "split", "", true},
		{"split dotted capital I (U+0130)", "SPL\u0130T", "", true},
		{"split padded mixed case", " SpLiT ", "", true},
		{"plain method", "qris", "", false},
	} {
		t.Run("scalar "+tc.name, func(t *testing.T) {
			in := ordinaryInput()
			in.PaymentMethod = tc.method
			if err := ValidateSaleInput(in); (err != nil) != tc.reject {
				t.Fatalf("scalar reject=%v got %v", tc.reject, err)
			}
		})
		t.Run("line "+tc.name, func(t *testing.T) {
			raw, _ := json.Marshal([]map[string]any{{"method": tc.method, "amount": 1000}})
			if _, _, err := parseTenders(raw); (err != nil) != tc.reject {
				t.Fatalf("line reject=%v got %v", tc.reject, err)
			}
		})
	}
	for name, method := range map[string]string{"NUL": "qr\x00is", "tab": "qr\tis", "control": "qr\u0007is"} {
		raw, _ := json.Marshal([]map[string]any{{"method": method, "amount": 1000}})
		if _, _, err := parseTenders(raw); err == nil {
			t.Fatalf("%s in a tender method must be a structural reject", name)
		}
	}
}

func TestOnlineSecondCashLineHasOwnMessage(t *testing.T) {
	isCash := func(m string) bool { return m == "cash" }
	_, err := settleTenders(100000, []TenderLine{{Method: "cash", Amount: 50000}, {Method: "qris", Amount: 20000}, {Method: "cash", Amount: 30000}}, isCash, tenderOnline)
	if !errors.Is(err, ErrTenderRejected) {
		t.Fatalf("must still match ErrTenderRejected (422), got %v", err)
	}
	if err.Error() == ErrTenderRejected.Error() || err.Error() == "" {
		t.Fatalf("message must not be the cash-shortfall text: %q", err.Error())
	}
	if want := "Hanya boleh satu pembayaran tunai"; len(err.Error()) < len(want) || err.Error()[:len(want)] != want {
		t.Fatalf("unexpected message %q", err.Error())
	}
}
