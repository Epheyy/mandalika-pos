package sync

import (
	"encoding/json"
	"testing"
	"time"
)

func TestVoidReplacementInputFromPayload(t *testing.T) {
	raw := `{"orderId":"o1","reasonCode":"salah_barang","mode":"replace","orderUuid":"0F8FAD5B-D9CB-469F-A165-70867728950E",
	  "replacement":{"orderUuid":"11111111-2222-4333-8444-555555555555","items":[{"productId":"p","productName":"P","variantSize":"s","price":1000,"quantity":1,"subtotal":1000}],
	  "paymentMethod":"cash","amountPaid":1000,"correctionTarget":"original_total","shiftId":"forged-shift","replacesOrderId":"forged"}}`
	var p voidPayload
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	if p.Replacement == nil || p.Replacement.CorrectionTarget != "original_total" {
		t.Fatalf("replacement not decoded: %+v", p.Replacement)
	}
	e := &Engine{Now: func() time.Time { return time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC) }}
	c := Caller{OutletID: "out", UserID: "u1", DisplayName: "Kasir", CanVoidOwnShift: true}
	in := e.replacementInput(c, BatchItem{IdempotencyKey: "k1"}, p.Replacement.orderPayload, "k1:replacement", Envelope{})
	if in.IdempotencyKey != "k1:replacement" || in.OrderUUID != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("key/uuid = %q / %q", in.IdempotencyKey, in.OrderUUID)
	}
	if !in.Offline || in.OutletID != "out" || in.CashierID != "u1" {
		t.Fatalf("identity/offline wrong: %+v", in)
	}
	// The payload's shift and link are never trusted: the service pins both to the voided sale.
	if in.ShiftID != "" {
		t.Fatalf("shift taken from the payload: %q", in.ShiftID)
	}
	vin := p.input(c, "o1")
	vin.ReplacementAtOriginalTotal = p.Replacement.CorrectionTarget == "original_total"
	if !vin.ReplacementAtOriginalTotal {
		t.Fatal("correctionTarget original_total not mapped")
	}
}
