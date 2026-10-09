// Package clientip derives the trustworthy client address for a request.
//
// The service sits behind Google's Cloud Run front end, which APPENDS the
// real peer address as the last X-Forwarded-For entry. Anything to the left
// of that is caller-controlled, so the address is taken by counting `hops`
// trusted proxies from the RIGHT end of the header, never from the left.
// True-Client-IP, X-Real-IP and Forwarded are deliberately never read.
package clientip

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

const unknown = "unknown"

// maxEntryLen bounds a selected entry before parsing; the longest valid IP
// text (IPv6 with embedded IPv4) is 45 bytes.
const maxEntryLen = 64

// Fallback reasons, short and constant so they are safe to log.
const (
	ReasonNone       = ""
	ReasonNoXFF      = "xff_missing"
	ReasonTooFew     = "xff_too_few_entries"
	ReasonUnparsable = "xff_unparseable"
	ReasonTooLong    = "xff_entry_too_long"
)

type ctxKey struct{}

type info struct {
	ip     string
	bucket string
}

// Result is the outcome of Extract.
type Result struct {
	Addr   netip.Addr // invalid when neither XFF nor RemoteAddr yielded an address
	Reason string     // non-empty when the RemoteAddr fallback was used because of XFF
}

// parseAddr accepts a bare IP only (no port, brackets or zone) and unmaps
// IPv4-mapped IPv6 addresses.
func parseAddr(s string) (netip.Addr, bool) {
	a, err := netip.ParseAddr(s)
	if err != nil || a.Zone() != "" {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

func remoteHost(remoteAddr string) netip.Addr {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.WithZone("").Unmap()
}

// Extract picks the client address. xffLines are all X-Forwarded-For header
// values; hops is the number of trusted proxies appending to it. hops <= 0
// ignores XFF entirely and uses the TCP peer.
func Extract(remoteAddr string, xffLines []string, hops int) Result {
	peer := remoteHost(remoteAddr)
	if hops <= 0 {
		return Result{Addr: peer}
	}
	if len(xffLines) == 0 {
		return Result{Addr: peer, Reason: ReasonNoXFF}
	}
	entry, found := nthFromRight(xffLines, hops)
	if !found {
		return Result{Addr: peer, Reason: ReasonTooFew}
	}
	entry = strings.TrimSpace(entry)
	if len(entry) > maxEntryLen {
		return Result{Addr: peer, Reason: ReasonTooLong}
	}
	a, ok := parseAddr(entry)
	if !ok {
		return Result{Addr: peer, Reason: ReasonUnparsable}
	}
	return Result{Addr: a}
}

// nthFromRight returns the n-th (1-based) comma-separated entry counting from
// the right across all header lines, as if the lines were joined with ",".
// It scans right-to-left without allocating and stops at the selected entry,
// so a huge header costs O(distance to the entry), not O(header size).
func nthFromRight(lines []string, n int) (string, bool) {
	count := 0
	for li := len(lines) - 1; li >= 0; li-- {
		rest := lines[li]
		for {
			i := strings.LastIndexByte(rest, ',')
			count++
			if count == n {
				return rest[i+1:], true
			}
			if i < 0 {
				break
			}
			rest = rest[:i]
		}
	}
	return "", false
}

// Bucket returns the rate-limit key for an address: IPv4 as-is, IPv6 as its
// /64 prefix (a single subscriber typically controls a whole /64).
func Bucket(a netip.Addr) string {
	if !a.IsValid() {
		return unknown
	}
	if a.Is4() {
		return a.String()
	}
	p, err := a.Prefix(64)
	if err != nil {
		return a.String()
	}
	return p.String()
}

// String returns the normalized address, or "unknown".
func String(a netip.Addr) string {
	if !a.IsValid() {
		return unknown
	}
	return a.String()
}

// WithAddr stores the resolved address in ctx.
func WithAddr(ctx context.Context, a netip.Addr) context.Context {
	return context.WithValue(ctx, ctxKey{}, info{ip: String(a), bucket: Bucket(a)})
}

func fromRequest(r *http.Request) info {
	if v, ok := r.Context().Value(ctxKey{}).(info); ok {
		return v
	}
	// Middleware not installed: use the TCP peer only, never headers.
	a := remoteHost(r.RemoteAddr)
	return info{ip: String(a), bucket: Bucket(a)}
}

// ClientIP is the full normalized client address, for logging.
func ClientIP(r *http.Request) string { return fromRequest(r).ip }

// ClientIPBucket is the address bucket for rate-limit keys (IPv6 -> /64).
func ClientIPBucket(r *http.Request) string { return fromRequest(r).bucket }
