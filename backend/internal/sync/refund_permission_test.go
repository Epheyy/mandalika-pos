package sync

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/auth"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/service"
)

// This same assertion runs before and after containment. The fake is the actual
// dispatch's refund invocation boundary, not evidence of PostgreSQL effects.
func TestRefundPermissionParityRegression(t *testing.T) {
	ctx := context.WithValue(context.Background(), auth.CtxRole, "cashier")
	ctx = context.WithValue(ctx, auth.CtxPerms, []string{"create_order"})
	directCalls := 0
	direct := mw.RequirePermission("process_refund")(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { directCalls++ }))
	w := httptest.NewRecorder()
	direct.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/orders/order-original/refund", nil).WithContext(ctx))
	if w.Code != http.StatusForbidden || directCalls != 0 {
		t.Fatalf("direct: status=%d calls=%d", w.Code, directCalls)
	}
	batchCalls := 0
	e := &Engine{Lookup: &fakeLookup{}}
	result := e.processOneWithRefund(ctx, Caller{OutletID: "outlet-original", UserID: "cashier-original"}, BatchItem{
		Type: "refund", IdempotencyKey: "refund-original-key",
		Payload: json.RawMessage(`{"orderId":"order-original","reason":"sealed return"}`),
	}, func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) { batchCalls++; return service.RefundResult{}, nil })
	if result.Status != "error" || result.IdempotencyKey != "refund-original-key" || batchCalls != 0 {
		t.Fatalf("batch must deny before refund mutation: result=%+v refundCalls=%d", result, batchCalls)
	}
}

const permissionMessage = "Sinkronisasi refund belum selesai: izin refund pada permintaan ini tidak mencukupi. Operasi tetap tersimpan dan belum terselesaikan. Jika uang sudah dikembalikan, jangan bayar ulang."

func TestRefundPermissionDispatch(t *testing.T) {
	for _, tc := range []struct {
		name, role  string
		permissions []string
		allowed     bool
	}{
		{"cashier allowed", "cashier", []string{"process_refund"}, true},
		{"technical admin", "admin", nil, true},
		{"cashier denied", "cashier", []string{"create_order"}, false},
		{"empty authority", "", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.WithValue(context.Background(), auth.CtxRole, tc.role)
			ctx = context.WithValue(ctx, auth.CtxPerms, tc.permissions)
			caller := Caller{OutletID: "active-outlet", UserID: "original-user", CanRefund: auth.HasPermission(ctx, "process_refund")}
			// Every untrusted assertion is deliberately stronger than the real caller.
			item := BatchItem{Type: "refund", IdempotencyKey: "original-key", Payload: json.RawMessage(`{"orderId":"original-order","reason":"original reason","role":"admin","permissions":["process_refund"],"CanRefund":true,"alreadyPaid":true,"approvedBy":"historical-supervisor","clientCreatedAt":"2020-01-01T00:00:00Z","outletId":"forged-outlet","userId":"forged-user"}`)}
			original := append([]byte(nil), item.Payload...)
			calls := 0
			result := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(ctx, caller, item, func(_ context.Context, _ pgx.Tx, in service.RefundInput) (service.RefundResult, error) {
				calls++
				if in.OutletID != "active-outlet" || in.OrderID != "original-order" || in.Reason != "original reason" {
					t.Fatalf("scope/arguments changed: %s %s %s", in.OutletID, in.OrderID, in.Reason)
				}
				// Identity comes from the authenticated caller, never from the payload;
				// no envelope means no shift.
				if in.UserID != "original-user" || in.ShiftID != "" {
					t.Fatalf("identity/shift changed: user=%q shift=%q", in.UserID, in.ShiftID)
				}
				return service.RefundResult{}, nil
			})
			if result.IdempotencyKey != item.IdempotencyKey || !reflect.DeepEqual([]byte(item.Payload), original) {
				t.Fatal("original evidence changed")
			}
			if tc.allowed {
				if calls != 1 || result.Status != "ok" || result.OrderID != "original-order" {
					t.Fatalf("allowed result=%+v calls=%d", result, calls)
				}
			} else if calls != 0 || result.Status != "error" || result.Error != permissionMessage || result.OrderID != "" {
				t.Fatalf("denied result=%+v calls=%d", result, calls)
			}
		})
	}
}

func TestRefundScopeFailurePropagatesWithoutSuccess(t *testing.T) {
	// The real service's outlet/order SQL remains unchanged. This checks only
	// scoped argument forwarding and propagation of its existing failure.
	result := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), Caller{OutletID: "outlet-a", CanRefund: true}, BatchItem{
		Type: "refund", IdempotencyKey: "original-key", Payload: json.RawMessage(`{"orderId":"order-in-b","reason":"sealed"}`),
	}, func(_ context.Context, _ pgx.Tx, in service.RefundInput) (service.RefundResult, error) {
		if in.OutletID != "outlet-a" || in.OrderID != "order-in-b" {
			t.Fatal("scope changed")
		}
		return service.RefundResult{}, service.ErrOrderClosed
	})
	if result.Status != "error" || result.Error != service.ErrOrderClosed.Error() || result.IdempotencyKey != "original-key" {
		t.Fatalf("result=%+v", result)
	}
}

func TestMixedBatchPreservesIndependentResults(t *testing.T) {
	items := []BatchItem{
		{Type: "order", IdempotencyKey: "first", Payload: json.RawMessage(`{}`)},
		{Type: "refund", IdempotencyKey: "denied", Payload: json.RawMessage(`{"orderId":"original-order"}`)},
		{Type: "customer_create", IdempotencyKey: "last", Payload: json.RawMessage(`{}`)},
	}
	var seen []string
	refundCalls, versionCalls := 0, 0
	result, err := processBatch(context.Background(), Caller{OutletID: "active-outlet"}, items,
		func(ctx context.Context, caller Caller, item BatchItem) ItemResult {
			seen = append(seen, item.IdempotencyKey)
			if item.Type == "refund" {
				return (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(ctx, caller, item, func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) { refundCalls++; return service.RefundResult{}, nil })
			}
			// Independent successes are synthetic, not order/customer DB coverage.
			return ItemResult{IdempotencyKey: item.IdempotencyKey, Status: "ok"}
		}, func(_ context.Context, outlet string) (VersionInfo, error) {
			versionCalls++
			if outlet != "active-outlet" {
				t.Fatal("wrong version scope")
			}
			return VersionInfo{Version: 7}, nil
		})
	if err != nil || result.Processed != 2 || result.Version != 7 || refundCalls != 0 || versionCalls != 1 {
		t.Fatalf("result=%+v err=%v refundCalls=%d versionCalls=%d", result, err, refundCalls, versionCalls)
	}
	if !reflect.DeepEqual(seen, []string{"first", "denied", "last"}) || len(result.Results) != 3 {
		t.Fatalf("seen=%v results=%v", seen, result.Results)
	}
	for i, status := range []string{"ok", "error", "ok"} {
		if result.Results[i].Status != status || result.Results[i].IdempotencyKey != items[i].IdempotencyKey {
			t.Fatalf("item %d=%+v", i, result.Results[i])
		}
	}
}

func TestRefundGuardPrecedesDecodeAndOtherDispatchIsUnchanged(t *testing.T) {
	for _, typ := range []string{"refund", "order", "shift_open", "shift_close", "cash_flow", "customer_create", "transfer_receive"} {
		result := (&Engine{Lookup: &fakeLookup{}}).processOne(context.Background(), Caller{}, BatchItem{Type: typ, IdempotencyKey: typ, Payload: json.RawMessage(`{`)})
		if result.Status != "error" || result.IdempotencyKey != typ {
			t.Fatalf("%s result=%+v", typ, result)
		}
		if typ == "refund" {
			if result.Error != permissionMessage {
				t.Fatal(result.Error)
			}
		} else if result.Error == permissionMessage || result.Error == "" {
			t.Fatalf("refund permission leaked into %s", typ)
		}
	}
	// A capability cannot be deserialized from any spelling in a body.
	var caller Caller
	if err := json.Unmarshal([]byte(`{"CanRefund":true,"canRefund":true,"role":"admin"}`), &caller); err != nil {
		t.Fatal(err)
	}
	if caller.CanRefund {
		t.Fatal("deserialized refund authority")
	}
	// Existing allowed service failures must stay non-success under the same key.
	r := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), Caller{CanRefund: true}, BatchItem{Type: "refund", IdempotencyKey: "same", Payload: json.RawMessage(`{}`)}, func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) {
		return service.RefundResult{}, apperr.New(apperr.Rejected, "synthetic service rejection")
	})
	if r.Status != "error" || r.IdempotencyKey != "same" || !strings.Contains(r.Error, "service rejection") {
		t.Fatalf("result=%+v", r)
	}
	if r.Code != string(apperr.Rejected) || r.Retryable == nil || *r.Retryable {
		t.Fatalf("a marked rejection must be non-retryable: %+v", r)
	}
	// An unmarked error is a server fault: sanitized text, retryable.
	r = (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), Caller{CanRefund: true}, BatchItem{Type: "refund", IdempotencyKey: "plain", Payload: json.RawMessage(`{}`)}, func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) {
		return service.RefundResult{}, errors.New("synthetic service fault")
	})
	if r.Status != "error" || r.Error != internalMessage || r.Code != string(apperr.Internal) || r.Retryable == nil || !*r.Retryable {
		t.Fatalf("unmarked error must be internal and retryable: %+v", r)
	}
}

// A06: a refund that already committed must replay as ok even when the caller's
// permission was removed since (same rule as the M3 attribution replay); only a
// key that never committed is forbidden.
func TestRefundForbiddenReplaysACommittedKey(t *testing.T) {
	item := BatchItem{Type: "refund", IdempotencyKey: "dev:committed", Payload: json.RawMessage(`{"orderId":"order-1","reason":"rusak"}`)}
	caller := Caller{OutletID: "outlet-1", UserID: "u1", CanRefund: false}
	refunds := 0
	refund := func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) { refunds++; return service.RefundResult{}, nil }

	applied := (&Engine{Lookup: &fakeLookup{applied: map[string]string{"dev:committed": "order-1"}}}).
		processOneWithRefund(context.Background(), caller, item, refund)
	if applied.Status != "ok" || applied.OrderID != "order-1" || applied.IdempotencyKey != "dev:committed" || applied.Error != "" || refunds != 0 {
		t.Fatalf("committed key must replay ok without a second refund: %+v refunds=%d", applied, refunds)
	}

	notApplied := (&Engine{Lookup: &fakeLookup{}}).processOneWithRefund(context.Background(), caller, item, refund)
	if notApplied.Status != "error" || notApplied.Error != permissionMessage || notApplied.Code != string(apperr.Forbidden) ||
		notApplied.Retryable == nil || *notApplied.Retryable || refunds != 0 {
		t.Fatalf("uncommitted key must stay forbidden: %+v refunds=%d", notApplied, refunds)
	}

	broken := (&Engine{Lookup: &fakeLookup{err: errors.New("synthetic db blip")}}).processOneWithRefund(context.Background(), caller, item, refund)
	if broken.Status != "error" || broken.Code != string(apperr.Internal) || broken.Retryable == nil || !*broken.Retryable || refunds != 0 {
		t.Fatalf("a failed probe must be retryable, never a review item: %+v", broken)
	}
}

// The probe is scoped by the capture-time outlet, like every other replay.
func TestRefundForbiddenProbeUsesEnvelopeOutlet(t *testing.T) {
	var gotType, gotScope string
	lk := &scopeSpy{fakeLookup: fakeLookup{}, onApplied: func(typ, scope string) { gotType, gotScope = typ, scope }}
	item := BatchItem{Type: "refund", IdempotencyKey: "dev:k", Payload: json.RawMessage(`{}`),
		Envelope: json.RawMessage(`{"v":1,"outletId":"X","userId":"u1","deviceId":"dev","capturedAt":"2026-01-01T00:00:00Z"}`)}
	lk.outlets = map[string]bool{"X": true}
	(&Engine{Lookup: lk}).processOneWithRefund(context.Background(), Caller{OutletID: "Y", UserID: "u1", Role: "admin"}, item,
		func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) { return service.RefundResult{}, nil })
	if gotType != "refund" || gotScope != "X" {
		t.Fatalf("probe type=%q scope=%q", gotType, gotScope)
	}
}

type scopeSpy struct {
	fakeLookup
	onApplied func(typ, scope string)
}

func (s *scopeSpy) Applied(ctx context.Context, typ, key, scope, fp string) (string, string, string, bool, error) {
	s.onApplied(typ, scope)
	return s.fakeLookup.Applied(ctx, typ, key, scope, fp)
}
