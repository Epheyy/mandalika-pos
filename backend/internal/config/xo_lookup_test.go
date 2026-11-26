package config

import (
	"testing"
	"time"
)

func TestParseXOLookup(t *testing.T) {
	cases := []struct {
		limit, window string
		wantL         int
		wantW         time.Duration
		bad           bool
	}{
		{"", "", 20, 600 * time.Second, false},
		{"5", "60", 5, 60 * time.Second, false},
		{" 7 ", "", 7, 600 * time.Second, false},
		{"0", "", 0, 0, true},
		{"abc", "", 0, 0, true},
		{"10001", "", 0, 0, true},
		{"", "0", 0, 0, true},
		{"", "86401", 0, 0, true},
	}
	for _, c := range cases {
		l, w, bad := parseXOLookup(c.limit, c.window)
		if (bad != "") != c.bad || (!c.bad && (l != c.wantL || w != c.wantW)) {
			t.Errorf("%+v -> %d %v bad=%q", c, l, w, bad)
		}
	}
}

func TestValidateRejectsBadXOLookup(t *testing.T) {
	c := base("development")
	c.xoLookupBad = "XO_LOOKUP_LIMIT must be an integer between 1 and 10000"
	if err := c.Validate(); err == nil {
		t.Fatal("a bad XO_LOOKUP_LIMIT must fail Validate")
	}
}
