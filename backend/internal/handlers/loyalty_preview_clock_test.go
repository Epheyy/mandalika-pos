package handlers

import (
	"testing"
	"time"

	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

func TestPreviewClockUsesClientTimeOnlyWithinTolerance(t *testing.T) {
	now := time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)
	in := func(d time.Duration) *time.Time { v := now.Add(d); return &v }
	cases := []struct {
		name string
		c    *time.Time
		want *time.Time
	}{
		{"nil stays nil", nil, nil},
		{"within tolerance kept", in(syncpkg.ClockTolerance - time.Second), in(syncpkg.ClockTolerance - time.Second)},
		{"past within tolerance kept", in(-syncpkg.ClockTolerance + time.Second), in(-syncpkg.ClockTolerance + time.Second)},
		{"far future uses server time", in(24 * time.Hour), &now},
		{"far past uses server time", in(-24 * time.Hour), &now},
	}
	for _, tc := range cases {
		got := previewClock(tc.c, now)
		if (got == nil) != (tc.want == nil) || (got != nil && !got.Equal(*tc.want)) {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
