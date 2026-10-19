package handlers

import (
	"testing"
	"time"
)

func TestLookupLimitDecision(t *testing.T) {
	// 10:00:20 UTC: 40 s left in the minute window, 13h59m40s left in the UTC day.
	now := time.Date(2026, 10, 19, 10, 0, 20, 0, time.UTC)

	if _, limited := lookupLimitDecision(1, 1, now); limited {
		t.Error("first lookup must pass")
	}
	if _, limited := lookupLimitDecision(lookupPerMinute, lookupPerDay-1, now); limited {
		t.Error("the 30th lookup in a minute must pass")
	}
	retry, limited := lookupLimitDecision(lookupPerMinute+1, 31, now)
	if !limited || retry != 40 {
		t.Errorf("31st in a minute: limited=%v retry=%d, want true/40", limited, retry)
	}
	retry, limited = lookupLimitDecision(1, lookupPerDay+1, now)
	wantRetry := int((13*time.Hour + 59*time.Minute + 40*time.Second).Seconds())
	if !limited || retry != wantRetry {
		t.Errorf("401st in a day: limited=%v retry=%d, want true/%d", limited, retry, wantRetry)
	}
	if retry, limited = lookupLimitDecision(lookupPerMinute+1, lookupPerDay+1, now); !limited || retry != wantRetry {
		t.Errorf("both exceeded must report the longer wait, got %d", retry)
	}
}
