package service

import (
	"strings"
	"time"
	"unicode/utf8"
)

var voidReasonCodes = map[VoidReasonCode]bool{
	VoidReasonWrongPayment: true, VoidReasonWrongItems: true, VoidReasonWrongPromo: true,
	VoidReasonWrongCustomer: true, VoidReasonDuplicate: true, VoidReasonTest: true, VoidReasonOther: true,
}

// NormalizeVoidReason validates the reason code and trims the note. "lainnya" needs a note
// of at least 10 runes; every note is at most 500 runes.
func NormalizeVoidReason(code, note string) (VoidReasonCode, string, error) {
	reason := VoidReasonCode(strings.TrimSpace(code))
	if !voidReasonCodes[reason] {
		return "", "", ErrVoidReasonInvalid
	}
	note = strings.TrimSpace(note)
	n := utf8.RuneCountInString(note)
	if n > MaxVoidNoteRunes {
		return "", "", ErrVoidReasonInvalid
	}
	if reason == VoidReasonOther && n < MinVoidOtherNoteRunes {
		return "", "", ErrVoidNoteRequired
	}
	return reason, note, nil
}

// checkVoidEligible decides whether the sale can be voided at all (not who may).
func checkVoidEligible(f voidFacts) error {
	switch {
	case f.HasVoid || f.Status == "cancelled":
		return ErrVoidAlreadyVoided
	case f.Status == "refunded" || f.Status == "partially_refunded" || f.RefundCount > 0:
		return ErrVoidRefunded
	case f.Status != "completed":
		return ErrVoidNotCompleted
	}
	window := f.WindowDays
	if window <= 0 {
		window = DefaultVoidWindowDays
	}
	if voidAgeDays(f.BusinessDate, f.Today) > window {
		return errVoidOutsideWindow(window)
	}
	return nil
}

// voidAgeDays is today minus the business day, in whole days (YYYY-MM-DD in the outlet's zone).
// An unparseable date reads as too old: fail closed.
func voidAgeDays(businessDate, today string) int {
	b, errB := time.Parse("2006-01-02", businessDate)
	t, errT := time.Parse("2006-01-02", today)
	if errB != nil || errT != nil {
		return 1 << 20
	}
	return int(t.Sub(b).Hours() / 24)
}

// matchesCallerShift: the sale belongs to the shift the caller is working, whether or not that
// shift is still open. "" never matches "". An unattributed sale (shift_id NULL, rung in a shift
// opened offline) matches only when the same device rang it, at the same outlet, after the
// caller's shift opened (O5).
func matchesCallerShift(f voidFacts, in VoidInput) bool {
	if in.CallerShiftID == "" {
		return false
	}
	if f.ShiftID != "" {
		return f.ShiftID == in.CallerShiftID
	}
	return f.DeviceID != "" && f.DeviceID == in.EnvelopeDeviceID &&
		f.OutletID != "" && f.OutletID == in.OutletID &&
		f.CallerShiftOpenedAt != nil && !f.CreatedAt.Before(*f.CallerShiftOpenedAt)
}

// decideVoidAuthority says why the caller may void this sale, or refuses.
func decideVoidAuthority(f voidFacts, in VoidInput) (VoidAuthority, error) {
	matches := matchesCallerShift(f, in)
	if matches && f.CallerShiftStatus == "open" && in.CanVoidOwnShift {
		return VoidOwnShift, nil
	}
	// A POS void of a sale in the caller's own shift, after that shift closed, is refused even for
	// a caller who also holds void_any: it is redone in the Backoffice.
	if in.Source != VoidSourceBackoffice && matches && f.CallerShiftStatus != "open" {
		return "", ErrVoidShiftClosed
	}
	if in.CanVoidAny {
		return VoidAny, nil
	}
	return "", ErrVoidForbidden
}

// inCloseSnapshot reports whether an order existed when its shift closed, so the close
// snapshot includes it.
func inCloseSnapshot(createdAt time.Time, closedAt *time.Time) bool {
	return closedAt != nil && !createdAt.After(*closedAt)
}

// voidCountedInClose is decision C's "counted": the order's closed shift's snapshot includes it
// (it was created before the close), or it is a replacement already booked as a correction.
func voidCountedInClose(f voidFacts) bool {
	return f.ShiftStatus == "closed" && (inCloseSnapshot(f.CreatedAt, f.ShiftClosedAt) || f.HasReplacementCorrection)
}

// replacementNeedsDelta: a replacement committed on a shift that is closed now needs a +delta
// only when the original was counted (or was itself a booked replacement); a late original never
// was, so replacing it books nothing. orig.ShiftClosedAt is the shift's closed_at as of the
// replacement's commit.
func replacementNeedsDelta(replShiftClosedNow bool, orig voidFacts) bool {
	return replShiftClosedNow && (inCloseSnapshot(orig.CreatedAt, orig.ShiftClosedAt) || orig.HasReplacementCorrection)
}
