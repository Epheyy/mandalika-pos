package clientip

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExtract(t *testing.T) {
	const peer = "10.0.0.9:4321"
	tests := []struct {
		name   string
		remote string
		xff    []string
		hops   int
		want   string
		reason string
	}{
		{"no xff uses remote host", peer, nil, 1, "10.0.0.9", ReasonNoXFF},
		{"single entry", peer, []string{"203.0.113.5"}, 1, "203.0.113.5", ""},
		{"forged then real", peer, []string{"1.2.3.4, 203.0.113.5"}, 1, "203.0.113.5", ""},
		{"two header lines", peer, []string{"1.2.3.4", "203.0.113.5"}, 1, "203.0.113.5", ""},
		{"whitespace trimmed", peer, []string{"1.2.3.4 ,   203.0.113.5  "}, 1, "203.0.113.5", ""},
		{"trailing comma", peer, []string{"203.0.113.5,"}, 1, "10.0.0.9", ReasonUnparsable},
		{"empty last entry", peer, []string{"203.0.113.5, "}, 1, "10.0.0.9", ReasonUnparsable},
		{"garbage last entry", peer, []string{"203.0.113.5, not-an-ip"}, 1, "10.0.0.9", ReasonUnparsable},
		{"port rejected", peer, []string{"203.0.113.5:80"}, 1, "10.0.0.9", ReasonUnparsable},
		{"brackets rejected", peer, []string{"[2001:db8::1]"}, 1, "10.0.0.9", ReasonUnparsable},
		{"zone rejected", peer, []string{"fe80::1%eth0"}, 1, "10.0.0.9", ReasonUnparsable},
		{"ipv4-mapped unmapped", peer, []string{"::ffff:203.0.113.5"}, 1, "203.0.113.5", ""},
		{"ipv6 compressed", peer, []string{"2001:db8::1"}, 1, "2001:db8::1", ""},
		{"ipv6 expanded", peer, []string{"2001:0db8:0000:0000:0000:0000:0000:0001"}, 1, "2001:db8::1", ""},
		{"hops 2 second-to-last", peer, []string{"9.9.9.9, 203.0.113.5, 198.51.100.7"}, 2, "203.0.113.5", ""},
		{"hops larger than entries", peer, []string{"203.0.113.5"}, 2, "10.0.0.9", ReasonTooFew},
		{"hops 0 ignores xff", peer, []string{"203.0.113.5"}, 0, "10.0.0.9", ""},
		{"ipv6 remote host", "[2001:db8::7]:99", nil, 0, "2001:db8::7", ""},
		{"remote without port", "10.0.0.9", nil, 0, "10.0.0.9", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := Extract(tt.remote, tt.xff, tt.hops)
			if got := String(res.Addr); got != tt.want {
				t.Fatalf("addr = %q, want %q", got, tt.want)
			}
			if res.Reason != tt.reason {
				t.Fatalf("reason = %q, want %q", res.Reason, tt.reason)
			}
		})
	}
}

func TestExtractUnparseableRemote(t *testing.T) {
	res := Extract("garbage", nil, 0)
	if String(res.Addr) != "unknown" || Bucket(res.Addr) != "unknown" {
		t.Fatalf("got %q / %q", String(res.Addr), Bucket(res.Addr))
	}
}

func bucketFor(t *testing.T, xff string) string {
	t.Helper()
	return Bucket(Extract("10.0.0.9:1", []string{xff}, 1).Addr)
}

func TestBucket(t *testing.T) {
	if got := bucketFor(t, "203.0.113.5"); got != "203.0.113.5" {
		t.Fatalf("ipv4 bucket = %q", got)
	}
	a := bucketFor(t, "2001:db8:1:2::1")
	b := bucketFor(t, "2001:db8:1:2:ffff:ffff:ffff:ffff")
	c := bucketFor(t, "2001:db8:1:3::1")
	if a != "2001:db8:1:2::/64" {
		t.Fatalf("bucket = %q", a)
	}
	if a != b {
		t.Fatalf("same /64 gave %q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("different /64 gave same bucket %q", a)
	}
}

func TestHeadersNeverTrusted(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.9:1"
	r.Header.Set("True-Client-IP", "1.1.1.1")
	r.Header.Set("X-Real-IP", "2.2.2.2")
	r.Header.Set("Forwarded", "for=3.3.3.3")
	res := Extract(r.RemoteAddr, r.Header.Values("X-Forwarded-For"), 1)
	if got := String(res.Addr); got != "10.0.0.9" {
		t.Fatalf("addr = %q", got)
	}
}

func TestHelpersWithoutMiddlewareUsePeer(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "[2001:db8:1:2::5]:80"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := ClientIP(r); got != "2001:db8:1:2::5" {
		t.Fatalf("ClientIP = %q", got)
	}
	if got := ClientIPBucket(r); got != "2001:db8:1:2::/64" {
		t.Fatalf("bucket = %q", got)
	}
}

func TestWithAddrRoundTrip(t *testing.T) {
	a := Extract("10.0.0.9:1", []string{"203.0.113.5"}, 1).Addr
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(WithAddr(context.Background(), a))
	if ClientIP(r) != "203.0.113.5" || ClientIPBucket(r) != "203.0.113.5" {
		t.Fatalf("got %q / %q", ClientIP(r), ClientIPBucket(r))
	}
}

func TestExtractHugeAndLongEntries(t *testing.T) {
	huge := strings.Repeat(",", 1<<20)
	if res := Extract("10.0.0.9:1", []string{huge}, 1); String(res.Addr) != "10.0.0.9" || res.Reason != ReasonUnparsable {
		t.Fatalf("comma-only: %q %q", String(res.Addr), res.Reason)
	}
	if res := Extract("10.0.0.9:1", []string{huge + "203.0.113.5"}, 1); String(res.Addr) != "203.0.113.5" {
		t.Fatalf("real last entry after huge prefix: %q", String(res.Addr))
	}
	long := strings.Repeat("1", 65)
	if res := Extract("10.0.0.9:1", []string{long}, 1); res.Reason != ReasonTooLong || String(res.Addr) != "10.0.0.9" {
		t.Fatalf("long entry: %q %q", String(res.Addr), res.Reason)
	}
	if res := Extract("10.0.0.9:1", []string{"", ""}, 3); res.Reason != ReasonTooFew {
		t.Fatalf("empty lines count as entries: %q", res.Reason)
	}
}

func BenchmarkExtractHugeHeader(b *testing.B) {
	huge := []string{strings.Repeat(",", 1<<20)}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		Extract("10.0.0.9:1", huge, 1)
	}
}
