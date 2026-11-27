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

func TestParsePublicLinkBase(t *testing.T) {
	cases := []struct {
		in   string
		prod bool
		want string
		bad  bool
	}{
		{"", true, DefaultPublicLinkBaseURL, false},
		{"https://pos.example.id/", true, "https://pos.example.id", false},
		{" https://pos.example.id/app// ", false, "https://pos.example.id/app", false},
		{"http://localhost:8080", false, "http://localhost:8080", false},
		{"http://localhost:8080", true, "", true},
		{"http://pos.example.id", false, "", true},
		{"https://", false, "", true},
		{"https://pos.example.id/?a=1", false, "", true},
		{"https://pos.example.id/#x", false, "", true},
		{"ftp://pos.example.id", false, "", true},
		{"pos.example.id", false, "", true},
	}
	for _, c := range cases {
		got, bad := parsePublicLinkBase(c.in, c.prod)
		if (bad != "") != c.bad || (!c.bad && got != c.want) {
			t.Errorf("%+v -> %q bad=%q", c, got, bad)
		}
	}
}

func TestValidateRejectsBadPublicLinkBase(t *testing.T) {
	c := base("development")
	c.publicLinkBad = "PUBLIC_LINK_BASE_URL must be an https URL with a host, no query or fragment"
	if err := c.Validate(); err == nil {
		t.Fatal("a bad PUBLIC_LINK_BASE_URL must fail Validate")
	}
}
