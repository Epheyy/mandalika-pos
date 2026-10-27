package sync

import (
	"encoding/json"
	"testing"
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
