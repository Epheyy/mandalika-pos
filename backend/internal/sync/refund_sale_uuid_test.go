package sync

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
)

// A41: a refund may reference a sale by the client's orderUuid (the sale was made
// offline on this tablet and its server id was never seen). The server resolves the
// uuid inside the refund's own keyed transaction.

const (
	saleUUID  = "11111111-2222-4333-8444-555555555555"
	serverID  = "99999999-8888-4777-8666-555555555555"
	otherID   = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	tabletDev = "tablet-1"
)

type resolveCall struct{ outlet, uuid string }

func runUUIDRefund(t *testing.T, payload string, resolver saleResolver) (ItemResult, []service.RefundInput, []resolveCall) {
	t.Helper()
	var calls []resolveCall
	e := &Engine{Lookup: &fakeLookup{}, SaleResolver: func(ctx context.Context, tx pgx.Tx, outlet, u string) (string, string, error) {
		calls = append(calls, resolveCall{outlet, u})
		return resolver(ctx, tx, outlet, u)
	}}
	var got []service.RefundInput
	res := e.processOneWithRefund(context.Background(), Caller{OutletID: "outlet-a", UserID: "u1", CanRefund: true},
		BatchItem{Type: "refund", IdempotencyKey: "k-refund", Payload: json.RawMessage(payload)},
		func(_ context.Context, _ pgx.Tx, in service.RefundInput) (service.RefundResult, error) { got = append(got, in); return service.RefundResult{}, nil })
	return res, got, calls
}

func found(id, dev string) saleResolver {
	return func(context.Context, pgx.Tx, string, string) (string, string, error) { return id, dev, nil }
}

func TestRefundBySaleUUIDResolvesServerID(t *testing.T) {
	res, got, calls := runUUIDRefund(t,
		`{"orderId":"","saleOrderUuid":"`+saleUUID+`","deviceId":"`+tabletDev+`","reason":"salah"}`,
		found(serverID, tabletDev))
	if res.Status != "ok" || res.OrderID != serverID {
		t.Fatalf("result=%+v", res)
	}
	if len(got) != 1 || got[0].OrderID != serverID || got[0].OutletID != "outlet-a" {
		t.Fatalf("refund input=%+v", got)
	}
	if len(calls) != 1 || calls[0].outlet != "outlet-a" || calls[0].uuid != saleUUID {
		t.Fatalf("resolver calls=%+v", calls)
	}
}

func TestRefundBySaleUUIDAcceptsMatchingServerID(t *testing.T) {
	res, got, _ := runUUIDRefund(t,
		`{"orderId":"`+serverID+`","saleOrderUuid":"`+saleUUID+`","deviceId":"`+tabletDev+`","reason":"salah"}`,
		found(serverID, tabletDev))
	if res.Status != "ok" || len(got) != 1 || got[0].OrderID != serverID {
		t.Fatalf("result=%+v got=%+v", res, got)
	}
}

func TestRefundBySaleUUIDFailures(t *testing.T) {
	notFound := func(context.Context, pgx.Tx, string, string) (string, string, error) {
		return "", "", service.ErrRefundOrderNotFound
	}
	for _, tc := range []struct {
		name, payload string
		resolver      saleResolver
		want          error
	}{
		{"missing sale", `{"orderId":"","saleOrderUuid":"` + saleUUID + `","deviceId":"tablet-1","reason":"r"}`, notFound, service.ErrRefundOrderNotFound},
		{"wrong device", `{"orderId":"","saleOrderUuid":"` + saleUUID + `","deviceId":"tablet-2","reason":"r"}`, found(serverID, tabletDev), service.ErrRefundSaleOtherDevice},
		{"no device in payload", `{"orderId":"","saleOrderUuid":"` + saleUUID + `","reason":"r"}`, found(serverID, tabletDev), service.ErrRefundSaleOtherDevice},
		{"malformed uuid", `{"orderId":"","saleOrderUuid":"not-a-uuid","deviceId":"tablet-1","reason":"r"}`, found(serverID, tabletDev), service.ErrRefundOrderInvalid},
		{"braced uuid", `{"orderId":"","saleOrderUuid":"{` + saleUUID + `}","deviceId":"tablet-1","reason":"r"}`, found(serverID, tabletDev), service.ErrRefundOrderInvalid},
		{"id and uuid mismatch", `{"orderId":"` + otherID + `","saleOrderUuid":"` + saleUUID + `","deviceId":"tablet-1","reason":"r"}`, found(serverID, tabletDev), service.ErrRefundOrderMismatch},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, got, _ := runUUIDRefund(t, tc.payload, tc.resolver)
			if res.Status != "error" || res.Error != tc.want.Error() || len(got) != 0 {
				t.Fatalf("result=%+v refundCalls=%d", res, len(got))
			}
			var ae *apperr.Error
			if !errors.As(tc.want, &ae) {
				t.Fatal("want must be an apperr")
			}
			if res.Retryable != nil && *res.Retryable {
				t.Fatalf("must not be retryable: %+v", res)
			}
		})
	}
}

func TestRefundWithoutSaleUUIDKeepsLegacyPath(t *testing.T) {
	res, got, calls := runUUIDRefund(t,
		`{"orderId":"`+serverID+`","reason":"salah"}`, found("x", "y"))
	if res.Status != "ok" || res.OrderID != serverID || len(got) != 1 || got[0].OrderID != serverID || len(calls) != 0 {
		t.Fatalf("result=%+v got=%+v calls=%+v", res, got, calls)
	}
}
