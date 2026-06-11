package service

import "testing"

func TestRewardLineAllowed(t *testing.T) {
	menu := []string{"p1", "p2|10ml ATOMIZER"}
	cases := []struct {
		name      string
		pid, size string
		want      bool
	}{
		{"whole-product entry allows any size", "p1", "110ml EXTRAIT DE PARFUM", true},
		{"whole-product entry allows empty size", "p1", "", true},
		{"variant entry allows the exact size", "p2", "10ml ATOMIZER", true},
		{"variant entry rejects another size", "p2", "110ml EXTRAIT DE PARFUM", false},
		{"variant entry rejects empty size", "p2", "", false},
		{"unlisted product rejected", "p3", "10ml ATOMIZER", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rewardLineAllowed(menu, tc.pid, tc.size); got != tc.want {
				t.Fatalf("rewardLineAllowed(%q,%q)=%v want %v", tc.pid, tc.size, got, tc.want)
			}
		})
	}
}
