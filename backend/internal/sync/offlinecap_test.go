package sync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
)

var (
	capKey = DeriveContactKey([]byte(strings.Repeat("k", 48)))
	capA   = time.Date(2026, 10, 19, 20, 0, 0, 0, time.UTC) // arrival
)

func ms(d time.Duration) *int64 { v := d.Milliseconds(); return &v }

// capEnv builds an envelope with a signed contact at capA-ago (signature for dev1).
func capEnv(ago time.Duration, mut func(*Envelope)) Envelope {
	tok := SignContact(capKey, "dev1", capA.Add(-ago))
	e := Envelope{V: 1, DeviceID: "dev1", CapturedAt: capA.Add(-time.Minute), Contact: &tok}
	if mut != nil {
		mut(&e)
	}
	return e
}

func TestOfflineCapVerdict(t *testing.T) {
	over := OfflineCap + 2*ClockTolerance
	cases := []struct {
		name   string
		typ    string
		env    Envelope
		refuse bool
		warn   bool
	}{
		{"fast path: signed contact 11h ago", "order", capEnv(11*time.Hour, nil), false, false},
		{"fast path ignores a lying device clock", "order", capEnv(11*time.Hour, func(e *Envelope) { e.OfflineMs = ms(30 * time.Hour) }), false, false},
		{"fast path at exactly cap+tol", "order", capEnv(OfflineCap+ClockTolerance, nil), false, false},
		{"signed contact too old, offlineMs over cap", "order", capEnv(13*time.Hour, func(e *Envelope) { e.OfflineMs = ms(over) }), true, false},
		{"signed contact too old, offlineMs within cap, consistent", "order", capEnv(13*time.Hour, func(e *Envelope) { e.OfflineMs = ms(10 * time.Minute) }), false, false},
		{"signed contact too old, offlineMs small but L+E far before A is fine", "refund", capEnv(20*time.Hour, func(e *Envelope) { e.OfflineMs = ms(time.Minute) }), false, false},
		{"over cap by contactDeviceAt", "cash_flow", capEnv(13*time.Hour, func(e *Envelope) {
			e.ContactDeviceAt = ptr(e.CapturedAt.Add(-over).UnixMilli())
		}), true, false},
		{"within tolerance over cap is still accepted", "order", capEnv(13*time.Hour, func(e *Envelope) { e.OfflineMs = ms(OfflineCap + time.Minute) }), false, false},
		{"unsigned: offlineMs over cap", "order", Envelope{DeviceID: "dev1", OfflineMs: ms(over)}, true, false},
		{"unsigned: offlineMs under cap", "order", Envelope{DeviceID: "dev1", OfflineMs: ms(time.Hour)}, false, false},
		{"unsigned: contactDeviceAt over cap", "refund", Envelope{DeviceID: "dev1", CapturedAt: capA, ContactDeviceAt: ptr(capA.Add(-over).UnixMilli())}, true, false},
		{"wrong device signature does not fast-path", "order", capEnv(time.Minute, func(e *Envelope) { e.DeviceID = "dev2"; e.OfflineMs = ms(over) }), true, false},
		{"negative elapsed flags only", "order", Envelope{DeviceID: "dev1", OfflineMs: ms(-time.Hour)}, false, true},
		{"fast path wins while the signed contact is recent", "order", capEnv(time.Hour, func(e *Envelope) { e.OfflineMs = ms(3 * time.Hour); e.ContactDeviceAt = nil }), false, false},
		{"signed contact too old and offlineMs 14h", "order", capEnv(13*time.Hour, func(e *Envelope) { e.OfflineMs = ms(14 * time.Hour) }), true, false},
		{"no evidence: accept", "order", Envelope{DeviceID: "dev1", CapturedAt: capA}, false, false},
		{"exempt shift_close over cap", "shift_close", Envelope{DeviceID: "dev1", OfflineMs: ms(over)}, false, false},
		{"exempt shift_open over cap", "shift_open", Envelope{DeviceID: "dev1", OfflineMs: ms(over)}, false, false},
		{"exempt customer_create over cap", "customer_create", Envelope{DeviceID: "dev1", OfflineMs: ms(over)}, false, false},
		{"exempt transfer_receive over cap", "transfer_receive", Envelope{DeviceID: "dev1", OfflineMs: ms(over)}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			refuse, warn := capVerdict(tc.typ, tc.env, capA, capKey)
			if refuse != tc.refuse || (warn != "") != tc.warn {
				t.Fatalf("refuse=%v warn=%q, want refuse=%v warn=%v", refuse, warn, tc.refuse, tc.warn)
			}
		})
	}
}

func TestOfflineCapVerdictSignedFutureContactIsNotTrusted(t *testing.T) {
	// A contact signed in the future (beyond tolerance) never verifies: evidence falls
	// back to the device-reported elapsed time.
	tok := SignContact(capKey, "dev1", capA.Add(3*time.Hour))
	env := Envelope{DeviceID: "dev1", Contact: &tok, OfflineMs: ms(OfflineCap + 2*ClockTolerance)}
	if refuse, _ := capVerdict("order", env, capA, capKey); !refuse {
		t.Fatal("future-signed contact must not rescue an over-cap item")
	}
}

func ptr(v int64) *int64 { return &v }

func TestReadEvidence(t *testing.T) {
	ev := readEvidence(capEnv(time.Hour, func(e *Envelope) { e.OfflineMs = ms(30 * time.Minute) }), capA, capKey)
	if !ev.Any || !ev.LOK || !ev.L.Equal(capA.Add(-time.Hour)) || !ev.HasE || ev.E != 30*time.Minute {
		t.Fatalf("%+v", ev)
	}
	if ev := readEvidence(Envelope{}, capA, capKey); ev.Any || ev.LOK || ev.HasE {
		t.Fatalf("empty envelope must have no evidence: %+v", ev)
	}
	// E is the larger of offlineMs and capturedAt-contactDeviceAt.
	e := Envelope{CapturedAt: capA, OfflineMs: ms(time.Hour), ContactDeviceAt: ptr(capA.Add(-3 * time.Hour).UnixMilli())}
	if ev := readEvidence(e, capA, capKey); ev.E != 3*time.Hour {
		t.Fatalf("E=%v want 3h", ev.E)
	}
}

func capItem(typ string, e Envelope) BatchItem {
	b, _ := json.Marshal(e)
	return BatchItem{Type: typ, IdempotencyKey: "dev1:key-1", Envelope: b,
		Payload: json.RawMessage(`{"orderId":"o1","reason":"r"}`)}
}

func capBase(mut func(*Envelope)) Envelope {
	e := Envelope{V: 1, OutletID: "X", UserID: "u1", DeviceID: "dev1", CapturedAt: capA.Add(-time.Minute), OfflineMs: ms(OfflineCap + time.Hour)}
	if mut != nil {
		mut(&e)
	}
	return e
}

func TestProcessOneRefusesOverCapOrderWithoutEffect(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}, ContactKey: capKey, Now: func() time.Time { return capA }}
	calls := 0
	res := e.processOneWithCommands(context.Background(), cashier(), capItem("order", capBase(nil)),
		func(context.Context, pgx.Tx, service.RefundInput) error { return nil },
		func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
			calls++
			return "o", false, false, nil
		})
	if calls != 0 || res.Status != "error" || res.Code != string(apperr.OfflineExpired) ||
		res.Retryable == nil || *res.Retryable || res.Error != offlineExpiredMessage {
		t.Fatalf("calls=%d res=%+v", calls, res)
	}
}

func TestProcessOneReplayProbeRunsBeforeOfflineRefusal(t *testing.T) {
	lk := &fakeLookup{applied: map[string]string{"dev1:key-1": "order-77"}}
	e := &Engine{Lookup: lk, ContactKey: capKey, Now: func() time.Time { return capA }}
	calls := 0
	res := e.processOneWithCommands(context.Background(), cashier(), capItem("order", capBase(nil)),
		func(context.Context, pgx.Tx, service.RefundInput) error { return nil },
		func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
			calls++
			return "o", false, false, nil
		})
	if calls != 0 || res.Status != "duplicate" || res.OrderID != "order-77" {
		t.Fatalf("an already-applied key must replay, not go to review: calls=%d res=%+v", calls, res)
	}
}

func TestProcessOneReplayProbeFailureIsRetryable(t *testing.T) {
	lk := &fakeLookup{err: errors.New("connection reset")}
	e := &Engine{Lookup: lk, ContactKey: capKey, Now: func() time.Time { return capA }}
	res := e.processOneWithCommands(context.Background(), cashier(), capItem("order", capBase(nil)),
		func(context.Context, pgx.Tx, service.RefundInput) error { return nil },
		func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
			return "o", false, false, nil
		})
	if res.Status != "error" || res.Retryable == nil || !*res.Retryable {
		t.Fatalf("a failed probe must be a retryable error, never a review item: %+v", res)
	}
}

func TestProcessOneAcceptsWithinCapAndRefusesRefundOverCap(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}, ContactKey: capKey, Now: func() time.Time { return capA }}
	calls := 0
	create := func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
		calls++
		return "o1", false, false, nil
	}
	noRefund := func(context.Context, pgx.Tx, service.RefundInput) error { t.Fatal("refund ran"); return nil }
	ok := e.processOneWithCommands(context.Background(), cashier(),
		capItem("order", capBase(func(e *Envelope) { e.OfflineMs = ms(time.Hour) })), noRefund, create)
	if calls != 1 || ok.Status != "ok" {
		t.Fatalf("within cap must process: calls=%d res=%+v", calls, ok)
	}
	c := cashier()
	c.CanRefund = true
	res := e.processOneWithCommands(context.Background(), c, capItem("refund", capBase(nil)), noRefund, create)
	if res.Status != "error" || res.Code != string(apperr.OfflineExpired) {
		t.Fatalf("refund over cap must be refused: %+v", res)
	}
}
