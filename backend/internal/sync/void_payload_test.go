package sync

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
)

func TestVoidPayloadInput(t *testing.T) {
	var p voidPayload
	raw := `{"orderId":"o1","reasonCode":"salah_barang","note":" catatan ","mode":"none","deviceId":"dev-1",
	  "orderUuid":"0F8FAD5B-D9CB-469F-A165-70867728950E","stockChoices":{"sale:x":"skip_counted"},
	  "role":"admin","canVoidAny":true,"callerShiftId":"forged","orderNumber":"A-1","total":1000}`
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	c := Caller{OutletID: "out", UserID: "u1", DisplayName: "Kasir", EnvelopeShiftID: "shift-1", EnvelopeDeviceID: "dev-1", CanVoidOwnShift: true}
	in := p.input(c, "order-1")
	if in.OrderID != "order-1" || in.OutletID != "out" || in.Reason != service.VoidReasonWrongItems || in.Note != " catatan " ||
		in.Mode != service.VoidModeNone || in.Source != service.VoidSourcePOS {
		t.Fatalf("input = %+v", in)
	}
	if in.CallerShiftID != "shift-1" || in.EnvelopeDeviceID != "dev-1" || in.DeviceID != "dev-1" || in.UserID != "u1" {
		t.Fatalf("identity must come from the caller/envelope: %+v", in)
	}
	if in.ClientVoidUUID != "0f8fad5b-d9cb-469f-a165-70867728950e" {
		t.Fatalf("client void uuid = %q, want the lower-cased orderUuid", in.ClientVoidUUID)
	}
	if in.CanVoidAny || !in.CanVoidOwnShift {
		t.Fatalf("rights must come from the caller, never the payload: %+v", in)
	}
	if in.StockChoices["sale:x"] != service.VoidStockSkipCounted {
		t.Fatalf("stock choices = %v", in.StockChoices)
	}
	// A non-canonical client uuid is dropped, not trusted.
	p.OrderUUID = "not-a-uuid"
	if got := p.input(c, "order-1").ClientVoidUUID; got != "" {
		t.Fatalf("non-canonical uuid kept: %q", got)
	}
}

func TestCappedTypeVoid(t *testing.T) {
	if !cappedType("void") {
		t.Fatal("a void captured long after the tablet was online must go to review, like a refund")
	}
}

func TestVoidResolveErrRewordsRefundErrors(t *testing.T) {
	if !errors.Is(voidResolveErr(service.ErrRefundOrderNotFound), service.ErrVoidNotFound) {
		t.Fatal("not found must read as a void error")
	}
	err := voidResolveErr(service.ErrRefundSaleOtherDevice)
	if code, _ := apperr.CodeOf(err); code != apperr.Rejected || err.Error() != "Transaksi yang dibatalkan tidak cocok dengan tablet ini." {
		t.Fatalf("other-device err = %v", err)
	}
	other := errors.New("boom")
	if voidResolveErr(other) != other {
		t.Fatal("unrelated errors pass through")
	}
}

func voidItem(key string) BatchItem {
	return BatchItem{
		Type: "void", IdempotencyKey: key,
		Payload: json.RawMessage(`{"orderId":"order-1","reasonCode":"salah_barang","mode":"none","orderNumber":"A-1","total":1000}`),
	}
}

func TestSyncVoidForbiddenWithoutPermission(t *testing.T) {
	res := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), Caller{OutletID: "out", UserID: "u1"}, voidItem("dev:void-1"), nil)
	if res.Status != "error" || res.Code != string(apperr.Forbidden) || res.Retryable == nil || *res.Retryable {
		t.Fatalf("result = %+v, want a non-retryable forbidden error", res)
	}
	if res.Error != service.ErrVoidForbidden.Error() {
		t.Fatalf("error text = %q", res.Error)
	}
}

func TestSyncVoidPermissionRevokedReplaysCommitted(t *testing.T) {
	fl := &fakeLookup{applied: map[string]string{"dev:void-1": "order-1"}, replacement: map[string]string{"dev:void-1": "repl-1"}}
	res := (&Engine{Lookup: fl}).processOneWithRefund(context.Background(), Caller{OutletID: "out", UserID: "u1"}, voidItem("dev:void-1"), nil)
	if res.Status != "ok" || res.OrderID != "order-1" || res.ReplacementOrderID != "repl-1" {
		t.Fatalf("result = %+v, want the first attempt's ok with its ids (M3 replay rule)", res)
	}
}

func TestSyncVoidReplacementModeNotYet(t *testing.T) {
	it := voidItem("dev:void-2")
	it.Payload = json.RawMessage(`{"orderId":"order-1","reasonCode":"salah_barang","mode":"replace"}`)
	res := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), Caller{OutletID: "out", UserID: "u1", CanVoidAny: true}, it, nil)
	if res.Status != "error" || res.Code != string(apperr.Rejected) || res.Error != service.ErrVoidReplacementInvalid.Error() {
		t.Fatalf("result = %+v", res)
	}
}
