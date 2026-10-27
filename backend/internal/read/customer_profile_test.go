package read

import (
	"testing"
	"time"
)

func day(n int) time.Time { return time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC).AddDate(0, 0, n) }

func TestMedianGapDays(t *testing.T) {
	cases := []struct {
		name  string
		times []time.Time
		want  int // 0 = nil
	}{
		{"two orders is not enough", []time.Time{day(0), day(30)}, 0},
		{"three orders, gaps 10 and 30 -> mean 20", []time.Time{day(0), day(10), day(40)}, 20},
		{"unsorted input", []time.Time{day(40), day(0), day(10)}, 20},
		{"odd gap count takes the middle", []time.Time{day(0), day(7), day(14), day(60)}, 7},
		{"same-day orders give no interval", []time.Time{day(0), day(0), day(0)}, 0},
		{"empty", nil, 0},
	}
	for _, c := range cases {
		got := MedianGapDays(c.times)
		switch {
		case c.want == 0 && got != nil:
			t.Errorf("%s: got %d, want nil", c.name, *got)
		case c.want != 0 && (got == nil || *got != c.want):
			t.Errorf("%s: got %v, want %d", c.name, got, c.want)
		}
	}
}
