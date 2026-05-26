package write

import "testing"

func TestFormatDocNo(t *testing.T) {
	tests := []struct {
		name string
		kind string
		year int
		n    int64
		want string
	}{
		{"first SJ of the year", "SJ", 2026, 1, "SJ-2026-00001"},
		{"first TT of the year", "TT", 2026, 1, "TT-2026-00001"},
		{"5-digit padding", "SJ", 2026, 42, "SJ-2026-00042"},
		{"year rollover", "SJ", 2027, 1, "SJ-2027-00001"},
		{"5-digit cap not exceeded", "TT", 2026, 99999, "TT-2026-99999"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatDocNo(tt.kind, tt.year, tt.n); got != tt.want {
				t.Fatalf("formatDocNo(%q,%d,%d) = %q, want %q",
					tt.kind, tt.year, tt.n, got, tt.want)
			}
		})
	}
}
