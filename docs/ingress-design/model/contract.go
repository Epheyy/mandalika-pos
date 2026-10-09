// Package ingressmodel is a proposal model, not application middleware.
// It is deliberately isolated in a nested module and cannot authenticate a cloud route.
package ingressmodel

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
)

const Header = "X-Mandalika-Client-IP"

type identityKey struct{}

type Identity struct {
	RawPeer string
	Client  netip.Addr
	Source  string
	Valid   bool
}

// Edge models the documented replacement, not a measurement of Google's edge.
// observedPeer comes from the test transport, never a request header.
func Edge(input http.Header, observedPeer string) http.Header {
	h := input.Clone()
	if h == nil {
		h = make(http.Header)
	}
	for k := range h {
		if strings.EqualFold(k, Header) {
			delete(h, k)
		}
	}
	h.Set(Header, observedPeer)
	return h
}

func Parse(h http.Header) (netip.Addr, error) {
	var values []string
	fields := 0
	for name, v := range h {
		if strings.EqualFold(name, Header) {
			fields++
			values = append(values, v...)
		}
	}
	if fields != 1 || len(values) != 1 {
		return netip.Addr{}, fmt.Errorf("identity must have exactly one field/value")
	}
	s := values[0]
	if len(s) == 0 || len(s) > 45 || strings.TrimSpace(s) != s || strings.ContainsAny(s, ",%[]") {
		return netip.Addr{}, fmt.Errorf("ambiguous or oversized identity")
	}
	for _, c := range s {
		if c <= 32 || c > 126 {
			return netip.Addr{}, fmt.Errorf("non-ASCII/control identity")
		}
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, err
	}
	return a.Unmap(), nil
}

// QualifiedRoute is supplied by the synthetic topology. It is NOT an HTTP field,
// Host check, source-IP allowlist, JWT implementation or deployable route attestation.
type QualifiedRoute bool

func Select(route QualifiedRoute, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !route {
			http.Error(w, "unqualified route", http.StatusForbidden)
			return
		}
		a, err := Parse(r.Header)
		if err != nil {
			// 401 would trigger the client's refresh/logout machinery. This is a
			// proposed infrastructure contract failure, not an invalid user token.
			http.Error(w, "client identity unavailable", http.StatusServiceUnavailable)
			return
		}
		id := Identity{RawPeer: r.RemoteAddr, Client: a, Source: "designated-edge", Valid: true}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
	})
}

func Selected(r *http.Request) (Identity, bool) {
	id, ok := r.Context().Value(identityKey{}).(Identity)
	return id, ok && id.Valid && id.Client.IsValid()
}

func GeneralKey(prefix string, id Identity, now time.Time, window time.Duration) string {
	return "rl:" + prefix + ":" + id.Client.String() + ":" + strconv.FormatInt(now.Unix()/int64(window.Seconds()), 10)
}

func LoginKey(id Identity, email string) string {
	// Preserve current email case handling, prefix and sliding expiry. Only the
	// proposed IP source/normalization changes. No new email/account policy.
	return "rl:login:" + id.Client.String() + ":" + email
}

// Limit models the existing INCR/first-EXPIRE/fail-open general limiter, using
// the proposed shared context instead of rewriting RemoteAddr. Real Redis client
// operations run only against synthetic miniredis in the tests.
func Limit(c *cache.Cache, prefix string, max int, window time.Duration, now time.Time, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := Selected(r)
		if !ok {
			http.Error(w, "client identity unavailable", http.StatusServiceUnavailable)
			return
		}
		key := GeneralKey(prefix, id, now, window)
		n, err := c.R.Incr(r.Context(), key).Result()
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		if n == 1 {
			c.R.Expire(r.Context(), key, window)
		}
		if n > int64(max) {
			w.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func LoginLimited(c *cache.Cache, id Identity, email string) bool {
	// The HTTP boundary returns 503 first. Keep this model helper fail-closed
	// as well if a future caller accidentally omits that boundary.
	if !id.Valid || !id.Client.IsValid() {
		return true
	}
	return c.Incr(context.Background(), LoginKey(id, email), 5*time.Minute) > 10
}
