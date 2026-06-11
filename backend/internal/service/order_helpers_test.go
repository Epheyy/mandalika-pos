package service

import "testing"

func TestParseMenu(t *testing.T) {
	t.Run("whole product entry → nil size set (all sizes)", func(t *testing.T) {
		ids, allowed := parseMenu([]string{"p1"})
		if len(ids) != 1 || ids[0] != "p1" || allowed["p1"] != nil {
			t.Fatalf("ids=%v allowed=%v", ids, allowed)
		}
	})
	t.Run("variant entries → size set", func(t *testing.T) {
		_, allowed := parseMenu([]string{"p1|10ml", "p1|110ml"})
		if allowed["p1"] == nil || !allowed["p1"]["10ml"] || !allowed["p1"]["110ml"] || allowed["p1"]["2ml"] {
			t.Fatalf("allowed=%v", allowed)
		}
	})
	t.Run("whole-product entry wins over variant entries", func(t *testing.T) {
		_, a1 := parseMenu([]string{"p1|10ml", "p1"})
		_, a2 := parseMenu([]string{"p1", "p1|10ml"})
		if a1["p1"] != nil || a2["p1"] != nil {
			t.Fatalf("whole product must win: %v %v", a1, a2)
		}
	})
	t.Run("distinct products keep entry order, no dup ids", func(t *testing.T) {
		ids, _ := parseMenu([]string{"p2|10ml", "p1", "p2|110ml"})
		if len(ids) != 2 || ids[0] != "p2" || ids[1] != "p1" {
			t.Fatalf("ids=%v", ids)
		}
	})
}

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
