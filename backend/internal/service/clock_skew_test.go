package service

import (
	"testing"
	"time"
)

func tpNow(h int) time.Time { return time.Date(2026, 1, 1, h, 0, 0, 0, time.UTC) }

func TestWithClockSkewWarning(t *testing.T) {
	cases := []struct {
		name    string
		reason  string
		skew    bool
		applied bool
		want    string
	}{
		{"no skew", "outside_hours", false, true, "outside_hours"},
		{"skew without any promo", "", true, false, ""},
		{"skew with promo, no prior reason", "", true, true, "clock_skew"},
		{"skew with promo appends", "outside_hours", true, true, "outside_hours,clock_skew"},
	}
	for _, tc := range cases {
		if got := withClockSkewWarning(tc.reason, tc.skew, tc.applied); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
	if ViolationClockSkew != "clock_skew" {
		t.Fatal("wire code changed")
	}
}

func TestSaleTimePrefersEvalTime(t *testing.T) {
	a, b := tpNow(1), tpNow(2)
	if got := pickSaleTime(&a, &b); !got.Equal(a) {
		t.Fatal("EvalTime must win over ClientCreated")
	}
	if got := pickSaleTime(nil, &b); !got.Equal(b) {
		t.Fatal("ClientCreated is the fallback")
	}
}
