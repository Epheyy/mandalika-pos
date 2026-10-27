package sync

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
)

type fakeLookup struct {
	outlets map[string]bool
	shifts  map[string]shiftState
	err     error
	applied map[string]string // key -> id
	// appliedFP is the fingerprint stored with an applied key (receipt-backed types);
	// a key absent here carries no fingerprint check (orders).
	appliedFP map[string]string
	outletQs  int
	shiftQs   int
}

func (f *fakeLookup) OutletExists(_ context.Context, id string) (bool, error) {
	f.outletQs++
	return f.outlets[id], f.err
}

func (f *fakeLookup) Applied(_ context.Context, _, key, _, fp string) (string, string, bool, error) {
	id, ok := f.applied[key]
	if want, has := f.appliedFP[key]; ok && has && want != fp {
		return "", "", false, service.ErrReceiptKeyConflict
	}
	return id, "duplicate", ok, f.err
}

func (f *fakeLookup) Shift(_ context.Context, _, id string) (shiftState, error) {
	f.shiftQs++
	return f.shifts[id], f.err
}

func env(mut func(*Envelope)) json.RawMessage {
	e := Envelope{V: 1, OutletID: "X", UserID: "u1", DeviceID: "dev", CapturedAt: time.Unix(1, 0).UTC()}
	if mut != nil {
		mut(&e)
	}
	b, _ := json.Marshal(e)
	return b
}

func cashier() Caller {
	return Caller{OutletID: "header-outlet", UserID: "u1", Role: "cashier", HomeOutletID: "X"}
}

func code(t *testing.T, err error) (apperr.Code, bool) {
	t.Helper()
	c, ok := apperr.CodeOf(err)
	if err != nil && !ok {
		t.Fatalf("uncoded error %v", err)
	}
	return c, ok
}

func TestAttributeLegacyNeverTouchesTheDatabase(t *testing.T) {
	// Engine{} has no pool: any lookup would panic.
	e := &Engine{}
	got, err := e.attribute(context.Background(), cashier(), BatchItem{Type: "order", IdempotencyKey: "dev:1"})
	if err != nil || got.OutletID != "header-outlet" {
		t.Fatalf("legacy: %+v %v", got, err)
	}
}

func TestAttributeLegacyCutoff(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{Now: func() time.Time { return now }}
	for _, tc := range []struct {
		name  string
		until time.Time
		want  bool // refused
	}{
		{"unset", time.Time{}, false},
		{"future", now.Add(time.Second), false},
		{"exactly now", now, true},
		{"past", now.Add(-time.Second), true},
	} {
		e.LegacyEnvelopeUntil = tc.until
		_, err := e.attribute(context.Background(), cashier(), BatchItem{IdempotencyKey: "dev:1"})
		if c, _ := code(t, err); (err != nil) != tc.want || (tc.want && c != apperr.ActorMismatch) {
			t.Errorf("%s: err=%v", tc.name, err)
		}
	}
}

func TestAttributeEnvelopeRules(t *testing.T) {
	lk := &fakeLookup{outlets: map[string]bool{"X": true, "Y": true}, shifts: map[string]shiftState{
		"open": shiftOpen, "closed": shiftClosed, "other": shiftOtherOutlet,
	}}
	e := &Engine{Lookup: lk}
	admin := Caller{OutletID: "header-outlet", UserID: "u1", Role: "admin"}
	for _, tc := range []struct {
		name     string
		c        Caller
		key      string
		env      json.RawMessage
		wantCode apperr.Code // "" = accepted
		wantOut  string
	}{
		{"cashier ok", cashier(), "dev:1", env(nil), "", "X"},
		{"cashier home compare ignores case", Caller{UserID: "u1", Role: "cashier", HomeOutletID: "x"}, "dev:1", env(nil), "", "X"},
		{"cashier other outlet", cashier(), "dev:1", env(func(e *Envelope) { e.OutletID = "Y" }), apperr.ActorMismatch, ""},
		{"cashier without stored outlet", Caller{UserID: "u1", Role: "cashier"}, "dev:1", env(nil), apperr.ActorMismatch, ""},
		{"admin any existing outlet", admin, "dev:1", env(func(e *Envelope) { e.OutletID = "Y" }), "", "Y"},
		{"admin unknown outlet", admin, "dev:1", env(func(e *Envelope) { e.OutletID = "nope" }), apperr.ActorMismatch, ""},
		{"other user", cashier(), "dev:1", env(func(e *Envelope) { e.UserID = "u2" }), apperr.ActorMismatch, ""},
		{"device prefix", cashier(), "other:1", env(nil), apperr.ActorMismatch, ""},
		{"device prefix needs the colon", cashier(), "devx:1", env(nil), apperr.ActorMismatch, ""},
		{"version", cashier(), "dev:1", env(func(e *Envelope) { e.V = 2 }), apperr.ActorMismatch, ""},
		{"missing outlet", cashier(), "dev:1", env(func(e *Envelope) { e.OutletID = "" }), apperr.ActorMismatch, ""},
		{"garbage", cashier(), "dev:1", json.RawMessage(`"x"`), apperr.ActorMismatch, ""},
		{"closed shift is accepted", cashier(), "dev:1", env(func(e *Envelope) { e.ShiftID = "closed" }), "", "X"},
		{"open shift", cashier(), "dev:1", env(func(e *Envelope) { e.ShiftID = "open" }), "", "X"},
		{"unknown shift is accepted", cashier(), "dev:1", env(func(e *Envelope) { e.ShiftID = "ghost" }), "", "X"},
		{"shift of another outlet", cashier(), "dev:1", env(func(e *Envelope) { e.ShiftID = "other" }), apperr.ActorMismatch, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := e.attribute(context.Background(), tc.c, BatchItem{Type: "order", IdempotencyKey: tc.key, Envelope: tc.env})
			c, _ := code(t, err)
			if c != tc.wantCode {
				t.Fatalf("code=%q err=%v", c, err)
			}
			if tc.wantCode == "" && (got.OutletID != tc.wantOut || got.UserID != "u1") {
				t.Fatalf("attributed to %+v", got)
			}
			if tc.wantCode != "" && got.OutletID != tc.c.OutletID {
				t.Fatalf("a refused item must keep the request caller, got %+v", got)
			}
		})
	}
}

func TestAttributeFailsClosedButRetryable(t *testing.T) {
	// An unreadable users row (Role "") and a database error are both retryable
	// internal failures, never a non-retryable mismatch that would park the item.
	e := &Engine{Lookup: &fakeLookup{err: errors.New("connection reset")}}
	_, err := e.attribute(context.Background(), Caller{UserID: "u1", OutletID: "h"}, BatchItem{IdempotencyKey: "dev:1", Envelope: env(nil)})
	if c, _ := code(t, err); c != apperr.Internal {
		t.Fatalf("empty role: %v", err)
	}
	admin := Caller{UserID: "u1", Role: "admin"}
	_, err = e.attribute(context.Background(), admin, BatchItem{IdempotencyKey: "dev:1", Envelope: env(nil)})
	if _, coded := apperr.CodeOf(err); err == nil || coded {
		t.Fatalf("a lookup failure must be returned uncoded (classified retryable), got %v", err)
	}
	if out := classifyItemError(err); !out.Retryable {
		t.Fatalf("lookup failure classified %+v", out)
	}
	if out := classifyItemError(mismatch("x")); out.Retryable || out.Code != apperr.ActorMismatch {
		t.Fatalf("mismatch classified %+v", out)
	}
}

func TestPayloadShift(t *testing.T) {
	lk := &fakeLookup{shifts: map[string]shiftState{"open": shiftOpen, "closed": shiftClosed, "other": shiftOtherOutlet}}
	e := &Engine{Lookup: lk}
	enveloped := BatchItem{Envelope: env(nil)}
	c := cashier()
	for _, tc := range []struct {
		name, in, want string
		it             BatchItem
		refused        bool
	}{
		{"open keeps", "open", "open", enveloped, false},
		{"closed keeps", "closed", "closed", enveloped, false},
		{"unknown is dropped", "ghost", "", enveloped, false},
		{"other outlet refused", "other", "", enveloped, true},
		{"empty stays empty", "", "", enveloped, false},
		{"legacy is untouched", "other", "other", BatchItem{}, false},
	} {
		got, err := e.payloadShift(context.Background(), c, tc.it, tc.in)
		if (err != nil) != tc.refused || got != tc.want {
			t.Errorf("%s: got %q err %v", tc.name, got, err)
		}
	}
	if lk.shiftQs != 4 {
		t.Errorf("legacy and empty ids must not query, queries=%d", lk.shiftQs)
	}
}

func TestMismatchOfAnAlreadyAppliedItemReplaysInsteadOfReview(t *testing.T) {
	lk := &fakeLookup{applied: map[string]string{"dev:1": "order-1"}}
	e := &Engine{Lookup: lk}
	calls := 0
	create := func(context.Context, service.CreateOrderInput) (string, bool, bool, error) {
		calls++
		return "x", false, false, nil
	}
	item := func(key string) BatchItem {
		return BatchItem{Type: "order", IdempotencyKey: key, Payload: json.RawMessage(`{}`), Envelope: env(func(e *Envelope) { e.UserID = "someone-else" })}
	}
	// Already applied: replayed as duplicate, never re-applied, never review.
	r := e.processOneWithCommands(context.Background(), cashier(), item("dev:1"), nil, create)
	if r.Status != "duplicate" || r.OrderID != "order-1" || r.Code != "" || calls != 0 {
		t.Fatalf("applied item: %+v calls=%d", r, calls)
	}
	// Not applied: still a non-retryable actor_mismatch and nothing runs.
	r = e.processOneWithCommands(context.Background(), cashier(), item("dev:2"), nil, create)
	if r.Status != "error" || r.Code != "actor_mismatch" || r.Retryable == nil || *r.Retryable || calls != 0 {
		t.Fatalf("unapplied item: %+v calls=%d", r, calls)
	}
	// A failing probe is a retryable internal error, never a verdict.
	lk.err = errors.New("connection reset")
	r = e.processOneWithCommands(context.Background(), cashier(), item("dev:3"), nil, create)
	if r.Code != "internal" || r.Retryable == nil || !*r.Retryable {
		t.Fatalf("probe failure: %+v", r)
	}
}

// L1: the already-applied probe is bound to the payload. A key committed for order A
// and resent with order B's payload is a key conflict (review), never "ok with A's id".
func TestAppliedProbesRejectAFingerprintMismatch(t *testing.T) {
	payloadA := json.RawMessage(`{"orderId":"order-A","reason":"rusak"}`)
	payloadB := json.RawMessage(`{"orderId":"order-B","reason":"rusak"}`)
	fpA, err := service.RequestFingerprint("refund", payloadA)
	if err != nil {
		t.Fatal(err)
	}
	lk := &fakeLookup{applied: map[string]string{"dev:k": "order-A"}, appliedFP: map[string]string{"dev:k": fpA}}
	e := &Engine{Lookup: lk}
	refunds := 0
	refund := func(context.Context, pgx.Tx, service.RefundInput) (service.RefundResult, error) { refunds++; return service.RefundResult{}, nil }
	conflict := func(t *testing.T, r ItemResult) {
		t.Helper()
		if r.Status != "error" || r.Code != string(apperr.KeyConflict) || r.OrderID != "" || r.Retryable == nil || *r.Retryable || refunds != 0 {
			t.Fatalf("a different payload under a committed key must be a key conflict: %+v refunds=%d", r, refunds)
		}
	}
	// Probe 1: the forbidden path (no permission).
	noPerm := Caller{OutletID: "outlet-1", UserID: "u1", CanRefund: false}
	same := e.processOneWithRefund(context.Background(), noPerm, BatchItem{Type: "refund", IdempotencyKey: "dev:k", Payload: payloadA}, refund)
	if same.Status != "ok" || same.OrderID != "order-A" || refunds != 0 {
		t.Fatalf("the same payload must still replay: %+v", same)
	}
	conflict(t, e.processOneWithRefund(context.Background(), noPerm, BatchItem{Type: "refund", IdempotencyKey: "dev:k", Payload: payloadB}, refund))
	// An unparseable payload never matches a stored fingerprint either.
	conflict(t, e.processOneWithRefund(context.Background(), noPerm, BatchItem{Type: "refund", IdempotencyKey: "dev:k", Payload: json.RawMessage(`{`)}, refund))

	// Probe 2: the M3 actor-mismatch path (enveloped by someone else).
	mism := func(p json.RawMessage) ItemResult {
		it := BatchItem{Type: "refund", IdempotencyKey: "dev:k", Payload: p,
			Envelope: env(func(e *Envelope) { e.UserID = "someone-else" })}
		return e.processOneWithRefund(context.Background(), Caller{OutletID: "X", UserID: "u1", Role: "cashier", HomeOutletID: "X", CanRefund: true}, it, refund)
	}
	if r := mism(payloadA); r.Status == "error" || r.OrderID != "order-A" || refunds != 0 {
		t.Fatalf("mismatch + same payload must replay: %+v", r)
	}
	conflict(t, mism(payloadB))
}

// EnvelopeShiftID feeds the refund_shift_id foreign key: it may only ever be a shift
// the lookup found at the attributed outlet (open or closed).
func TestAttributeEnvelopeShiftIDOnlyForKnownShifts(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{shifts: map[string]shiftState{"open": shiftOpen, "closed": shiftClosed, "other": shiftOtherOutlet}}}
	for _, tc := range []struct{ name, shift, want string }{
		{"open", "open", "open"},
		{"closed", "closed", "closed"},
		{"unknown", "ghost", ""},
		{"none", "", ""},
	} {
		got, err := e.attribute(context.Background(), cashier(), BatchItem{Type: "refund", IdempotencyKey: "dev:1",
			Envelope: env(func(e *Envelope) { e.ShiftID = tc.shift })})
		if err != nil || got.EnvelopeShiftID != tc.want {
			t.Errorf("%s: EnvelopeShiftID=%q err=%v want %q", tc.name, got.EnvelopeShiftID, err, tc.want)
		}
	}
	// Another outlet's shift is refused outright, and legacy items carry none.
	if _, err := e.attribute(context.Background(), cashier(), BatchItem{Type: "refund", IdempotencyKey: "dev:1",
		Envelope: env(func(e *Envelope) { e.ShiftID = "other" })}); err == nil {
		t.Error("shift of another outlet must be refused")
	}
	if got, err := e.attribute(context.Background(), cashier(), BatchItem{Type: "refund", IdempotencyKey: "dev:1"}); err != nil || got.EnvelopeShiftID != "" {
		t.Errorf("legacy: %+v %v", got, err)
	}
}

func TestBatchRefundForwardsAttributedShiftAndUser(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{shifts: map[string]shiftState{"s1": shiftOpen}}}
	var got service.RefundInput
	refund := func(_ context.Context, _ pgx.Tx, in service.RefundInput) (service.RefundResult, error) { got = in; return service.RefundResult{}, nil }
	it := BatchItem{Type: "refund", IdempotencyKey: "dev:1", Payload: json.RawMessage(`{"orderId":"o1","reason":"rusak"}`),
		Envelope: env(func(e *Envelope) { e.ShiftID = "s1" })}
	c := cashier()
	c.CanRefund, c.DisplayName = true, "Kasir Satu"
	if r := e.processOneWithRefund(context.Background(), c, it, refund); r.Status != "ok" {
		t.Fatalf("%+v", r)
	}
	if got.OutletID != "X" || got.ShiftID != "s1" || got.UserID != "u1" || got.UserName != "Kasir Satu" {
		t.Fatalf("refund input %+v", got)
	}
}

func TestAttributeAcceptsOfflineEvidenceAndUnknownKeys(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}}
	raw := json.RawMessage(`{"v":1,"outletId":"X","userId":"u1","deviceId":"dev","capturedAt":"2026-10-19T08:00:00Z",` +
		`"contact":{"at":"2026-10-19T07:00:00Z","sig":"s"},"contactDeviceAt":1,"offlineMs":2,"futureKey":{"a":1}}`)
	if _, err := e.attribute(context.Background(), cashier(), BatchItem{IdempotencyKey: "dev:1", Envelope: raw}); err != nil {
		t.Fatalf("new and unknown envelope keys must attribute: %v", err)
	}
}
