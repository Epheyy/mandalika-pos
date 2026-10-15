package auth

import (
	"strings"
	"testing"
)

func TestLoginRateKey(t *testing.T) {
	if a, b := loginRateKey("203.0.113.5", "User@X.com "), loginRateKey("203.0.113.5", "user@x.com"); a != b {
		t.Fatalf("case/space variants differ: %q vs %q", a, b)
	}
	if got := loginRateKey("2001:db8:1:2::/64", "a@b.c"); !strings.HasPrefix(got, "2001:db8:1:2::/64:") || strings.Contains(got, "a@b.c") {
		t.Fatalf("ipv6 key = %q", got)
	}
	if loginRateKey("1.1.1.1", "a@b.c") == loginRateKey("1.1.1.2", "a@b.c") {
		t.Fatal("different IPs must differ")
	}
}

func TestLoginEmailKeyIgnoresIPAndCase(t *testing.T) {
	if a, b := loginEmailKey(" Cashier@Outlet.ID"), loginEmailKey("cashier@outlet.id"); a != b {
		t.Fatalf("case/space variants differ: %q vs %q", a, b)
	}
	if got := loginEmailKey("A@B.c"); got != loginEmailKey("a@b.c") || strings.Contains(got, "a@b.c") {
		t.Fatalf("key = %q", got)
	}
}

func TestEmailCapReached(t *testing.T) {
	for n, want := range map[int64]bool{0: false, 29: false, 30: true, 31: true} {
		if got := emailCapReached(n); got != want {
			t.Errorf("emailCapReached(%d) = %v, want %v", n, got, want)
		}
	}
}
