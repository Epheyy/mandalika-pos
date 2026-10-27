package sync

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
)

func decodeRefundPayload(t *testing.T, raw string) refundPayload {
	t.Helper()
	var p refundPayload
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRefundPayloadLegacyShape(t *testing.T) {
	in := decodeRefundPayload(t, `{"orderId":"o","reason":"x","deviceId":"d","unknownKey":1}`).input(Caller{OutletID: "out"}, "o")
	if in.Items != nil || in.RefundAmount != nil || in.ReasonCode != "" || in.ClientRefundUUID != "" || in.Channel != "sync" {
		t.Fatalf("%+v", in)
	}
}

func TestRefundPayloadItemsShape(t *testing.T) {
	in := decodeRefundPayload(t, `{"reason":"x","deviceId":"d","orderUuid":"00000000-0000-4000-8f01-00000000000A","reasonCode":"rusak",
		"refundAmount":1500.4,"items":[{"lineNo":0,"quantity":2},{"lineNo":3,"quantity":1}]}`).input(Caller{OutletID: "out"}, "o")
	if len(in.Items) != 2 || in.Items[1].LineNo != 3 || in.Items[0].Quantity != 2 {
		t.Fatalf("items %+v", in.Items)
	}
	if in.RefundAmount == nil || *in.RefundAmount != 1500 || in.ReasonCode != "rusak" || in.DeviceID != "d" {
		t.Fatalf("%+v", in)
	}
	if in.ClientRefundUUID != "00000000-0000-4000-8f01-00000000000a" {
		t.Fatalf("uuid %q", in.ClientRefundUUID)
	}
}

func TestRefundPayloadEdgeCases(t *testing.T) {
	// `items: []` stays a non-nil empty slice (the service rejects it); null/absent is legacy.
	if in := decodeRefundPayload(t, `{"items":[]}`).input(Caller{}, "o"); in.Items == nil || len(in.Items) != 0 {
		t.Fatalf("empty items %+v", in.Items)
	}
	if in := decodeRefundPayload(t, `{"items":null}`).input(Caller{}, "o"); in.Items != nil {
		t.Fatal("null items must be legacy")
	}
	if in := decodeRefundPayload(t, `{"refundAmount":-3}`).input(Caller{}, "o"); in.RefundAmount == nil || *in.RefundAmount != -1 {
		t.Fatalf("negative amount %+v", in.RefundAmount)
	}
	if in := decodeRefundPayload(t, `{"orderUuid":"not-a-uuid"}`).input(Caller{}, "o"); in.ClientRefundUUID != "" {
		t.Fatal("bad uuid must be dropped")
	}
}

// A missing or misspelled item key must never become line 0 / a valid quantity.
func TestRefundPayloadMalformedItemIsInvalid(t *testing.T) {
	for _, raw := range []string{
		`{"items":[{"lineNr":0,"quantity":1}]}`,
		`{"items":[{"lineNo":0}]}`,
		`{"items":[{}]}`,
	} {
		in := decodeRefundPayload(t, raw).input(Caller{}, "o")
		if len(in.Items) != 1 {
			t.Fatalf("%s: items %+v", raw, in.Items)
		}
		if _, err := service.ValidateRefundExtras(in.Items, ""); err != service.ErrRefundLineUnknown {
			t.Fatalf("%s: err=%v, want ErrRefundLineUnknown", raw, err)
		}
	}
}

func TestReplayCarriesRefundState(t *testing.T) {
	lk := &fakeLookup{applied: map[string]string{"k": "order-1"}, refundState: map[string]string{"k": "partial"}}
	e := &Engine{Lookup: lk}
	r, replayed := e.replay(context.Background(), Caller{OutletID: "X"}, BatchItem{Type: "refund", IdempotencyKey: "k", Payload: json.RawMessage(`{}`)},
		ItemResult{IdempotencyKey: "k"}, func(error) ItemResult { return ItemResult{} })
	if !replayed || r.RefundState != "partial" || r.OrderID != "order-1" {
		t.Fatalf("%+v replayed=%v", r, replayed)
	}
}
