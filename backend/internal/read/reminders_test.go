package read

import (
	"testing"
	"time"
)

func keyByMMDD(keys []dayKey, mmdd int) (dayKey, bool) {
	for _, k := range keys {
		if k.mmdd == mmdd {
			return k, true
		}
	}
	return dayKey{}, false
}

func TestMMDDWindow_BasicWeek(t *testing.T) {
	// 2026-06-09 + 7 days → 0609..0616, soonest-first, du 0..7.
	keys := mmddWindow(time.Date(2026, 6, 9, 0, 0, 0, 0, time.UTC), 7)
	if len(keys) != 8 {
		t.Fatalf("len = %d want 8", len(keys))
	}
	if keys[0].mmdd != 609 || keys[0].daysUntil != 0 {
		t.Fatalf("first = %+v want {609,0}", keys[0])
	}
	if keys[7].mmdd != 616 || keys[7].daysUntil != 7 {
		t.Fatalf("last = %+v want {616,7}", keys[7])
	}
}

func TestMMDDWindow_MonthRollover(t *testing.T) {
	// Jan 28 + 7 → crosses into February.
	keys := mmddWindow(time.Date(2026, 1, 28, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 201); !ok {
		t.Fatalf("expected 0201 (Feb 1) in window")
	}
}

func TestMMDDWindow_YearEndWrap(t *testing.T) {
	// Dec 28 + 7 → wraps into January.
	keys := mmddWindow(time.Date(2026, 12, 28, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 1228); !ok {
		t.Fatalf("expected 1228 in window")
	}
	if _, ok := keyByMMDD(keys, 101); !ok {
		t.Fatalf("expected 0101 (Jan 1) in wrapped window")
	}
}

func TestMMDDWindow_LeapDayFoldedInNonLeapYear(t *testing.T) {
	// 2027 is NOT a leap year. A window spanning Mar 1 must also include 0229
	// so Feb-29 birthdays still get a reminder (celebrated Mar 1).
	keys := mmddWindow(time.Date(2027, 2, 26, 0, 0, 0, 0, time.UTC), 7)
	if _, ok := keyByMMDD(keys, 229); !ok {
		t.Fatalf("expected 0229 folded into non-leap-year window")
	}
}

func TestMMDDWindow_LeapDayNaturalInLeapYear(t *testing.T) {
	// 2028 IS a leap year — Feb 29 occurs naturally.
	keys := mmddWindow(time.Date(2028, 2, 26, 0, 0, 0, 0, time.UTC), 7)
	k, ok := keyByMMDD(keys, 229)
	if !ok || k.daysUntil != 3 {
		t.Fatalf("expected natural 0229 at du=3, got %+v ok=%v", k, ok)
	}
}
