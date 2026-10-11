package sync

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
)

func TestSaleInputBatchMappingAndIndependentResults(t *testing.T) {
	items := []BatchItem{
		{Type: "order", IdempotencyKey: "valid-cash", Payload: json.RawMessage(`{"paymentMethod":"cash","amountPaid":100,"items":[{"price":100,"quantity":1,"subtotal":100}]}`)},
		{Type: "order", IdempotencyKey: "invalid-original", Payload: json.RawMessage(`{"paymentMethod":"cash","amountPaid":100,"alreadyPaid":true,"role":"admin","Offline":true,"outletId":"forged","cashierId":"forged","clientCreatedAt":"2020-01-01T00:00:00Z","items":[{"price":100,"quantity":-1,"subtotal":100,"isReward":true,"isBundle":true}]}`)},
		{Type: "order", IdempotencyKey: "valid-noncash", Payload: json.RawMessage(`{"paymentMethod":"bca","discountValue":null,"pointsRedeemed":null,"items":[{"price":0,"quantity":1,"subtotal":0,"isReward":true}]}`)},
		{Type: "order", IdempotencyKey: "invalid-wire", Payload: json.RawMessage(`{"paymentMethod":"cash","items":[{"price":0,"quantity":1.5,"subtotal":0}]}`)},
		{Type: "refund", IdempotencyKey: "denied-refund", Payload: json.RawMessage(`{"orderId":"original","CanRefund":true}`)},
	}
	original := make([][]byte, len(items))
	for i, it := range items {
		original[i] = append([]byte(nil), it.Payload...)
	}
	var accepted []string
	calls, refundCalls := 0, 0
	r, err := processBatch(context.Background(), Caller{OutletID: "trusted-outlet", UserID: "trusted-user"}, items,
		func(ctx context.Context, c Caller, it BatchItem) ItemResult {
			return (&Engine{Lookup: &fakeLookup{}}).processOneWithCommands(ctx, c, it,
				func(context.Context, pgx.Tx, string, string, string) error { refundCalls++; return nil },
				func(_ context.Context, in service.CreateOrderInput) (string, bool, bool, error) {
					calls++
					if in.OutletID != "trusted-outlet" || in.CashierID != "trusted-user" || !in.Offline {
						t.Fatalf("mapping=%+v", in)
					}
					if in.IdempotencyKey == "invalid-original" && (in.ClientCreated == nil || in.ClientCreated.Year() != 2020) {
						t.Fatal("captured date lost")
					}
					if err := service.ValidateSaleInput(in); err != nil {
						return "", false, false, err
					}
					accepted = append(accepted, in.IdempotencyKey)
					return "synthetic-order", false, false, nil
				})
		}, func(context.Context, string) (VersionInfo, error) { return VersionInfo{Version: 3}, nil })
	if err != nil || r.Processed != 2 || calls != 3 || refundCalls != 0 || !reflect.DeepEqual(accepted, []string{"valid-cash", "valid-noncash"}) {
		t.Fatalf("result=%+v err=%v calls=%d accepted=%v refunds=%d", r, err, calls, accepted, refundCalls)
	}
	for i, status := range []string{"ok", "error", "ok", "error", "error"} {
		if r.Results[i].Status != status || r.Results[i].IdempotencyKey != items[i].IdempotencyKey || !reflect.DeepEqual([]byte(items[i].Payload), original[i]) {
			t.Fatalf("item=%+v", r.Results[i])
		}
	}
}
