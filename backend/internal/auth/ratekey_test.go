package auth

import "testing"

func TestLoginRateKey(t *testing.T) {
	if a, b := loginRateKey("203.0.113.5", "User@X.com "), loginRateKey("203.0.113.5", "user@x.com"); a != b {
		t.Fatalf("case/space variants differ: %q vs %q", a, b)
	}
	if got := loginRateKey("2001:db8:1:2::/64", "a@b.c"); got != "2001:db8:1:2::/64:a@b.c" {
		t.Fatalf("ipv6 key = %q", got)
	}
	if loginRateKey("1.1.1.1", "a@b.c") == loginRateKey("1.1.1.2", "a@b.c") {
		t.Fatal("different IPs must differ")
	}
}
