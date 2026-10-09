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

func TestLoginEmailKeyIgnoresIPAndCase(t *testing.T) {
	if a, b := loginEmailKey(" Cashier@Outlet.ID"), loginEmailKey("cashier@outlet.id"); a != b {
		t.Fatalf("case/space variants differ: %q vs %q", a, b)
	}
	if got := loginEmailKey("a@b.c"); got != "rl:login:email:a@b.c" {
		t.Fatalf("key = %q", got)
	}
}

func TestEmailCapReached(t *testing.T) {
	cases := []struct {
		stored string
		ok     bool
		want   bool
	}{
		{"", false, false}, // no failures recorded / cache miss
		{"29", true, false},
		{"30", true, true},
		{"31", true, true},
		{"garbage", true, false},
	}
	for _, c := range cases {
		if got := emailCapReached(c.stored, c.ok); got != c.want {
			t.Errorf("emailCapReached(%q,%v) = %v, want %v", c.stored, c.ok, got, c.want)
		}
	}
}
