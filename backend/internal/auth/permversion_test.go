package auth

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
)

type countingLoader struct {
	mu     sync.Mutex
	calls  int
	v      int64
	exists bool
	err    error
}

func (l *countingLoader) load(context.Context, string) (int64, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	return l.v, l.exists, l.err
}

func (l *countingLoader) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newPV(t *testing.T, c *cache.Cache, l *countingLoader) (*PermVersions, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	return NewPermVersions(c, l.load, PermVersionOptions{Now: clk.now}), clk
}

func TestPermVersionsMemoHitSkipsRedisAndDB(t *testing.T) {
	c, mr := miniCache(t)
	l := &countingLoader{v: 3, exists: true}
	p, _ := newPV(t, c, l)
	ctx := context.Background()
	if _, _, err := p.Current(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	before := mr.CommandCount()
	for i := 0; i < 100; i++ {
		v, ok, err := p.Current(ctx, "u1")
		if err != nil || !ok || v != 3 {
			t.Fatalf("got %d %v %v", v, ok, err)
		}
	}
	if d := mr.CommandCount() - before; d != 0 {
		t.Fatalf("memo hits cost %d redis commands, want 0", d)
	}
	if l.count() != 1 {
		t.Fatalf("loads = %d, want 1", l.count())
	}
}

func TestPermVersionsRedisMissLoadsAndPopulatesNX(t *testing.T) {
	c, mr := miniCache(t)
	l := &countingLoader{v: 4, exists: true}
	p, _ := newPV(t, c, l)
	if v, ok, err := p.Current(context.Background(), "u1"); err != nil || !ok || v != 4 {
		t.Fatalf("got %d %v %v", v, ok, err)
	}
	got, err := mr.Get(permVersionKey("u1"))
	if err != nil || got != "4" {
		t.Fatalf("redis = %q %v, want 4", got, err)
	}
	if ttl := mr.TTL(permVersionKey("u1")); ttl <= 0 || ttl > 2*time.Minute {
		t.Fatalf("ttl = %v", ttl)
	}
}

func TestPermVersionsRedisHitSkipsDB(t *testing.T) {
	c, mr := miniCache(t)
	_ = mr.Set(permVersionKey("u1"), "8")
	l := &countingLoader{v: 1, exists: true}
	p, _ := newPV(t, c, l)
	if v, _, _ := p.Current(context.Background(), "u1"); v != 8 || l.count() != 0 {
		t.Fatalf("v=%d loads=%d, want 8 / 0", v, l.count())
	}
}

func TestPermVersionsPublishOverridesStalePopulate(t *testing.T) {
	ctx := context.Background()
	t.Run("publish after populate", func(t *testing.T) {
		c, mr := miniCache(t)
		l := &countingLoader{v: 4, exists: true}
		p, _ := newPV(t, c, l)
		_, _, _ = p.Current(ctx, "u1")
		p.Publish(ctx, "u1", 5)
		if got, _ := mr.Get(permVersionKey("u1")); got != "5" {
			t.Fatalf("redis = %q, want 5", got)
		}
		if v, _, _ := p.Current(ctx, "u1"); v != 5 {
			t.Fatalf("memo = %d, want 5", v)
		}
	})
	t.Run("populate after publish", func(t *testing.T) {
		c, mr := miniCache(t)
		l := &countingLoader{v: 4, exists: true}
		p, clk := newPV(t, c, l)
		p.Publish(ctx, "u1", 5)
		clk.advance(10 * time.Second) // memo expired, redis still holds 5
		_, _, _ = p.Current(ctx, "u1")
		if got, _ := mr.Get(permVersionKey("u1")); got != "5" {
			t.Fatalf("redis = %q, want 5 (a stale populate must not win)", got)
		}
	})
	t.Run("stale NX populate loses to a published key", func(t *testing.T) {
		c, mr := miniCache(t)
		p, _ := newPV(t, c, &countingLoader{v: 4, exists: true})
		p.Publish(ctx, "u1", 5)
		if c.SetNX(ctx, permVersionKey("u1"), "4", time.Minute) {
			t.Fatal("SETNX overwrote a published key")
		}
		if got, _ := mr.Get(permVersionKey("u1")); got != "5" {
			t.Fatalf("redis = %q", got)
		}
	})
}

func TestPermVersionsRedisKeyExpiryBoundsStaleness(t *testing.T) {
	c, mr := miniCache(t)
	_ = mr.Set(permVersionKey("u1"), "3")
	mr.SetTTL(permVersionKey("u1"), 2*time.Minute)
	l := &countingLoader{v: 6, exists: true}
	p, clk := newPV(t, c, l)
	if v, _, _ := p.Current(context.Background(), "u1"); v != 3 {
		t.Fatalf("v = %d, want stale 3", v)
	}
	mr.FastForward(2 * time.Minute)
	clk.advance(10 * time.Second)
	if v, _, _ := p.Current(context.Background(), "u1"); v != 6 || l.count() != 1 {
		t.Fatalf("v=%d loads=%d, want reloaded 6 / 1", v, l.count())
	}
}

func TestPermVersionsRedisDownUsesDBOncePerTTL(t *testing.T) {
	ctx := context.Background()
	opts := cache.Options{DialTimeout: 100 * time.Millisecond, OpTimeout: 100 * time.Millisecond}
	refused, _ := cache.Connect(ctx, "redis://127.0.0.1:1/0", opts)
	disabled, _ := cache.Connect(ctx, "", cache.Options{})
	for name, c := range map[string]*cache.Cache{"refused": refused, "disabled": disabled} {
		t.Run(name, func(t *testing.T) {
			l := &countingLoader{v: 2, exists: true}
			p, clk := newPV(t, c, l)
			for i := 0; i < 50; i++ {
				if v, ok, err := p.Current(ctx, "u1"); err != nil || !ok || v != 2 {
					t.Fatalf("got %d %v %v", v, ok, err)
				}
			}
			if l.count() != 1 {
				t.Fatalf("loads = %d, want 1", l.count())
			}
			clk.advance(6 * time.Second)
			_, _, _ = p.Current(ctx, "u1")
			if l.count() != 2 {
				t.Fatalf("loads after memo TTL = %d, want 2", l.count())
			}
		})
	}
}

func TestPermVersionsNoVerdictIsError(t *testing.T) {
	ctx := context.Background()
	disabled, _ := cache.Connect(ctx, "", cache.Options{})
	l := &countingLoader{err: errors.New("db down")}
	p, _ := newPV(t, disabled, l)
	v, ok, err := p.Current(ctx, "u1")
	if err == nil || ok || v != 0 {
		t.Fatalf("got %d %v %v, want an error and exists=false", v, ok, err)
	}
	_, _, _ = p.Current(ctx, "u1")
	if l.count() != 2 {
		t.Fatalf("an error must not be memoized: loads=%d", l.count())
	}
}

func TestPermVersionsDeletedIsDefinitive(t *testing.T) {
	c, mr := miniCache(t)
	l := &countingLoader{exists: false}
	p, _ := newPV(t, c, l)
	v, ok, err := p.Current(context.Background(), "u1")
	if err != nil || ok {
		t.Fatalf("got %d %v %v, want deleted", v, ok, err)
	}
	if !Revoked(0, v, ok) {
		t.Fatal("a deleted user must be revoked")
	}
	if got, _ := mr.Get(permVersionKey("u1")); got != "x" {
		t.Fatalf("redis = %q, want x", got)
	}
	_, _, _ = p.Current(context.Background(), "u1")
	if l.count() != 1 {
		t.Fatalf("negative result must be memoized: loads=%d", l.count())
	}
}

func TestPermVersionsPublishDeleted(t *testing.T) {
	c, mr := miniCache(t)
	p, _ := newPV(t, c, &countingLoader{v: 1, exists: true})
	ctx := context.Background()
	_, _, _ = p.Current(ctx, "u1")
	p.PublishDeleted(ctx, "u1")
	if _, ok, _ := p.Current(ctx, "u1"); ok {
		t.Fatal("deleted user still exists in the memo")
	}
	if got, _ := mr.Get(permVersionKey("u1")); got != "x" {
		t.Fatalf("redis = %q", got)
	}
}

func TestPermVersionsObserveRaisesNeverLowers(t *testing.T) {
	c, _ := miniCache(t)
	p, _ := newPV(t, c, &countingLoader{v: 4, exists: true})
	ctx := context.Background()
	_, _, _ = p.Current(ctx, "u1")
	p.Observe("u1", 7)
	if v, _, _ := p.Current(ctx, "u1"); v != 7 {
		t.Fatalf("after Observe(7) = %d", v)
	}
	p.Observe("u1", 2)
	if v, _, _ := p.Current(ctx, "u1"); v != 7 {
		t.Fatalf("Observe must never lower: %d", v)
	}
	p.PublishDeleted(ctx, "u2")
	p.Observe("u2", 9)
	if _, ok, _ := p.Current(ctx, "u2"); ok {
		t.Fatal("Observe revived a deleted entry")
	}
}

func TestPermVersionsKeyOutsideReadCachePrefix(t *testing.T) {
	if strings.HasPrefix(permVersionKey("u1"), cache.ReadKeyPrefix) {
		t.Fatalf("%q would be wiped by every write", permVersionKey("u1"))
	}
	if !strings.HasPrefix(permVersionKey("u1"), "authpv:") {
		t.Fatalf("key = %q", permVersionKey("u1"))
	}
}

func TestPermVersionsMemoBounded(t *testing.T) {
	disabled, _ := cache.Connect(context.Background(), "", cache.Options{})
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := &countingLoader{v: 1, exists: true}
	p := NewPermVersions(disabled, l.load, PermVersionOptions{MemoMax: 3, Now: clk.now})
	for _, u := range []string{"a", "b", "c", "d", "e"} {
		_, _, _ = p.Current(context.Background(), u)
		if n := p.memoLen(); n > 3 {
			t.Fatalf("memo holds %d entries after %s, max 3", n, u)
		}
	}
}

func TestRevokedTable(t *testing.T) {
	for _, c := range []struct {
		name         string
		token, cur   int64
		exists, want bool
	}{
		{"equal", 3, 3, true, false},
		{"older token", 2, 3, true, true},
		{"newer token", 5, 4, true, false},
		{"deleted", 9, 0, false, true},
		{"legacy token at zero", 0, 0, true, false},
		{"legacy token after a bump", 0, 1, true, true},
	} {
		if got := Revoked(c.token, c.cur, c.exists); got != c.want {
			t.Errorf("%s: Revoked(%d,%d,%v) = %v, want %v", c.name, c.token, c.cur, c.exists, got, c.want)
		}
	}
}
