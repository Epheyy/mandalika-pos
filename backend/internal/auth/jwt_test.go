package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

var jwtTestSecret = []byte(strings.Repeat("s", 48))

func TestIssueAccessVRoundTripsPermVersion(t *testing.T) {
	tok, err := IssueAccessV(jwtTestSecret, time.Minute, "u1", "cashier", "o1", []string{"a"}, 7)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseAccess(jwtTestSecret, tok)
	if err != nil {
		t.Fatal(err)
	}
	if c.PermVersion != 7 {
		t.Fatalf("pv = %d, want 7", c.PermVersion)
	}
}

func TestParseAccessWithoutPVIsZero(t *testing.T) {
	tok, err := IssueAccess(jwtTestSecret, time.Minute, "u1", "cashier", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), `"pv"`) {
		t.Fatalf("legacy token must not carry pv: %s", payload)
	}
	c, err := ParseAccess(jwtTestSecret, tok)
	if err != nil {
		t.Fatal(err)
	}
	if c.PermVersion != 0 {
		t.Fatalf("pv = %d, want 0", c.PermVersion)
	}
}
