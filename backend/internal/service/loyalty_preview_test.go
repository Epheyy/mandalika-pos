package service

import "testing"

func TestContains(t *testing.T) {
	cases := []struct {
		name string
		ids  []string
		id   string
		want bool
	}{
		{"present", []string{"a", "b"}, "b", true},
		{"absent", []string{"a", "b"}, "c", false},
		{"empty menu", nil, "a", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := contains(c.ids, c.id); got != c.want {
				t.Fatalf("contains(%v,%q)=%v want %v", c.ids, c.id, got, c.want)
			}
		})
	}
}
