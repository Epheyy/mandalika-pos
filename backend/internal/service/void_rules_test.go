package service

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeVoidReason(t *testing.T) {
	cases := []struct {
		name, code, note string
		want             error
	}{
		{"lainnya short note", "lainnya", "terlalu", ErrVoidNoteRequired},
		{"lainnya 10 runes", "lainnya", "sepuluh ok", nil},
		{"lainnya blank note", "lainnya", "   ", ErrVoidNoteRequired},
		{"other reason empty note", "salah_barang", "", nil},
		{"unknown code", "x", "", ErrVoidReasonInvalid},
		{"empty code", "", "", ErrVoidReasonInvalid},
		{"note 501 runes", "salah_barang", strings.Repeat("é", 501), ErrVoidReasonInvalid},
		{"note 500 runes", "salah_barang", strings.Repeat("é", 500), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := NormalizeVoidReason(c.code, c.note)
			if !errors.Is(err, c.want) && !(c.want == nil && err == nil) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
	reason, note, err := NormalizeVoidReason(" salah_promo ", "  catatan  ")
	if err != nil || reason != VoidReasonWrongPromo || note != "catatan" {
		t.Fatalf("trim = %q %q %v", reason, note, err)
	}
}

func TestCheckVoidEligible(t *testing.T) {
	base := voidFacts{Status: "completed", BusinessDate: "2026-11-05", Today: "2026-11-12", WindowDays: 7}
	with := func(mut func(*voidFacts)) voidFacts { f := base; mut(&f); return f }
	cases := []struct {
		name string
		f    voidFacts
		want error
	}{
		{"completed in window", base, nil},
		{"partially refunded", with(func(f *voidFacts) { f.Status = "partially_refunded" }), ErrVoidRefunded},
		{"refund rows on completed", with(func(f *voidFacts) { f.RefundCount = 1 }), ErrVoidRefunded},
		{"refunded", with(func(f *voidFacts) { f.Status = "refunded" }), ErrVoidRefunded},
		{"cancelled", with(func(f *voidFacts) { f.Status = "cancelled" }), ErrVoidAlreadyVoided},
		{"has void row", with(func(f *voidFacts) { f.HasVoid = true; f.Status = "cancelled" }), ErrVoidAlreadyVoided},
		{"odd status", with(func(f *voidFacts) { f.Status = "pending" }), ErrVoidNotCompleted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := checkVoidEligible(c.f); !errors.Is(err, c.want) && !(c.want == nil && err == nil) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
	err := checkVoidEligible(with(func(f *voidFacts) { f.BusinessDate = "2026-11-04" }))
	if err == nil || !strings.Contains(err.Error(), "7 hari") {
		t.Fatalf("outside window err = %v, want text with 7 hari", err)
	}
	if err := checkVoidEligible(with(func(f *voidFacts) { f.BusinessDate = "garbage" })); err == nil {
		t.Fatal("an unparseable business date must fail closed")
	}
	if err := checkVoidEligible(with(func(f *voidFacts) { f.WindowDays = 0; f.BusinessDate = "2026-11-05" })); err != nil {
		t.Fatalf("zero window falls back to the default: %v", err)
	}
}

var (
	voidT0      = time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	voidOpened  = voidT0.Add(-2 * time.Hour)
	voidClosedT = voidT0.Add(time.Hour)
)

func ownShiftFacts() (voidFacts, VoidInput) {
	f := voidFacts{Status: "completed", OutletID: "o1", DeviceID: "dev1", CreatedAt: voidT0, ShiftID: "s1", ShiftStatus: "open", CallerShiftStatus: "open", CallerShiftOpenedAt: &voidOpened}
	in := VoidInput{OutletID: "o1", Source: VoidSourcePOS, CallerShiftID: "s1", EnvelopeDeviceID: "dev1", CanVoidOwnShift: true}
	return f, in
}

func TestDecideVoidAuthorityOwnShift(t *testing.T) {
	f, in := ownShiftFacts()
	if got, err := decideVoidAuthority(f, in); err != nil || got != VoidOwnShift {
		t.Fatalf("got %q %v, want own_shift", got, err)
	}
	in.CanVoidOwnShift = false
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("without the permission err = %v, want forbidden", err)
	}
}

func TestDecideVoidAuthorityOwnShiftClosedRefused(t *testing.T) {
	f, in := ownShiftFacts()
	f.ShiftStatus, f.CallerShiftStatus = "closed", "closed"
	in.CanVoidAny = true
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidShiftClosed) {
		t.Fatalf("err = %v, want ErrVoidShiftClosed even with void_any", err)
	}
	// The Backoffice (no envelope shift) may still void it with void_any.
	in.Source, in.CallerShiftID = VoidSourceBackoffice, ""
	if got, err := decideVoidAuthority(f, in); err != nil || got != VoidAny {
		t.Fatalf("backoffice got %q %v, want any", got, err)
	}
}

func TestDecideVoidAuthorityAny(t *testing.T) {
	f, in := ownShiftFacts()
	in.Source, in.CallerShiftID, in.CanVoidOwnShift, in.CanVoidAny = VoidSourceBackoffice, "", false, true
	if got, err := decideVoidAuthority(f, in); err != nil || got != VoidAny {
		t.Fatalf("got %q %v, want any", got, err)
	}
	// A POS cashier with void_any voiding an older sale from another (closed) shift.
	f, in = ownShiftFacts()
	f.ShiftID = "s0"
	in.CanVoidOwnShift, in.CanVoidAny = false, true
	if got, err := decideVoidAuthority(f, in); err != nil || got != VoidAny {
		t.Fatalf("pos older sale got %q %v, want any", got, err)
	}
}

func TestDecideVoidAuthorityNone(t *testing.T) {
	f, in := ownShiftFacts()
	f.ShiftID = "s0"
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("err = %v, want forbidden", err)
	}
}

func TestDecideVoidAuthorityUnattributedSale(t *testing.T) {
	mk := func() (voidFacts, VoidInput) {
		f, in := ownShiftFacts()
		f.ShiftID = ""
		f.ShiftStatus = ""
		return f, in
	}
	f, in := mk()
	if got, err := decideVoidAuthority(f, in); err != nil || got != VoidOwnShift {
		t.Fatalf("same device after open: got %q %v, want own_shift", got, err)
	}
	f, in = mk()
	in.EnvelopeDeviceID = "dev2"
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("another device err = %v", err)
	}
	f, in = mk()
	f.CreatedAt = voidOpened.Add(-time.Minute)
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("created before opened_at err = %v", err)
	}
	f, in = mk()
	in.CallerShiftID = ""
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("empty caller shift vs empty order shift err = %v", err)
	}
	f, in = mk()
	f.OutletID = "o2"
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("another outlet err = %v", err)
	}
	f, in = mk()
	f.DeviceID, in.EnvelopeDeviceID = "", ""
	if _, err := decideVoidAuthority(f, in); !errors.Is(err, ErrVoidForbidden) {
		t.Fatalf("empty device vs empty device err = %v", err)
	}
}

func TestVoidCountedInClose(t *testing.T) {
	closedAt := voidClosedT
	before := voidFacts{ShiftStatus: "closed", ShiftClosedAt: &closedAt, CreatedAt: voidT0}
	late := voidFacts{ShiftStatus: "closed", ShiftClosedAt: &closedAt, CreatedAt: closedAt.Add(time.Minute)}
	lateCorrected := late
	lateCorrected.HasReplacementCorrection = true
	open := voidFacts{ShiftStatus: "open", CreatedAt: voidT0}
	for name, c := range map[string]struct {
		f    voidFacts
		want bool
	}{
		"created before close": {before, true}, "late sale": {late, false},
		"late but booked replacement": {lateCorrected, true}, "open shift": {open, false},
	} {
		if got := voidCountedInClose(c.f); got != c.want {
			t.Errorf("%s = %v, want %v", name, got, c.want)
		}
	}
}

func TestReplacementNeedsDelta(t *testing.T) {
	closedAt := voidClosedT
	orig := voidFacts{ShiftClosedAt: &closedAt, CreatedAt: voidT0}
	if !replacementNeedsDelta(true, orig) {
		t.Error("original created before close: want true")
	}
	late := voidFacts{ShiftClosedAt: &closedAt, CreatedAt: closedAt.Add(time.Minute)}
	if replacementNeedsDelta(true, late) {
		t.Error("late original: want false")
	}
	late.HasReplacementCorrection = true
	if !replacementNeedsDelta(true, late) {
		t.Error("late original that is a booked replacement: want true")
	}
	if replacementNeedsDelta(false, orig) {
		t.Error("shift still open: want false")
	}
}
