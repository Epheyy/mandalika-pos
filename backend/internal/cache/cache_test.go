package cache

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

const (
	testDial = 300 * time.Millisecond
	testOp   = 200 * time.Millisecond
)

func opts() Options { return Options{DialTimeout: testDial, OpTimeout: testOp} }

// blackhole accepts connections and never replies.
func blackhole(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() })
		}
	}()
	return "redis://" + ln.Addr().String() + "/0"
}

func TestDisabledModeIsNoOp(t *testing.T) {
	c, err := Connect(context.Background(), "", opts())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if c.Enabled() || c.Available() {
		t.Fatal("disabled cache must report unavailable")
	}
	if _, found, err := c.GetE(ctx, "k"); found || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("GetE found=%v err=%v", found, err)
	}
	c.Set(ctx, "k", "v", time.Minute)
	if _, ok := c.Get(ctx, "k"); ok {
		t.Fatal("disabled Get must miss")
	}
	if c.Status() != "disabled" {
		t.Fatalf("status %q", c.Status())
	}
	var nilCache *Cache
	if _, ok := nilCache.Get(ctx, "k"); ok || nilCache.Available() {
		t.Fatal("nil cache must behave as disabled")
	}
}

func TestConnectRefusedIsDegradedNotFatal(t *testing.T) {
	start := time.Now()
	c, err := Connect(context.Background(), "redis://127.0.0.1:1/0", opts())
	if err != nil {
		t.Fatalf("Connect must not fail on reachability: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("Connect took %v", time.Since(start))
	}
	if c.Available() {
		t.Fatal("breaker must be open after failed startup ping")
	}
	if c.Status() != "down" {
		t.Fatalf("status %q", c.Status())
	}
	begin := time.Now()
	if _, _, err := c.GetE(context.Background(), "k"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err %v", err)
	}
	if time.Since(begin) > 20*time.Millisecond {
		t.Fatal("open breaker must answer immediately")
	}
}

func TestUnparseableURLReturnsDisabledCacheAndError(t *testing.T) {
	c, err := Connect(context.Background(), "://nope", opts())
	if err == nil {
		t.Fatal("expected a config error")
	}
	if c == nil || c.Enabled() {
		t.Fatal("must return a usable disabled cache")
	}
}

func TestBlackholeOpsAreBoundedAndOpenBreaker(t *testing.T) {
	c := newCache(redis.NewClient(mustOptions(t, blackhole(t), opts())), opts())
	ctx := context.Background()
	for i := 0; i < breakerThreshold; i++ {
		begin := time.Now()
		_, _, err := c.GetE(ctx, "k")
		if err == nil || errors.Is(err, ErrUnavailable) {
			t.Fatalf("op %d: want transport error, got %v", i, err)
		}
		if d := time.Since(begin); d > testOp+100*time.Millisecond {
			t.Fatalf("op %d took %v, want <= op timeout + 100ms", i, d)
		}
	}
	begin := time.Now()
	if _, _, err := c.GetE(ctx, "k"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("breaker should be open, err=%v", err)
	}
	if time.Since(begin) > 20*time.Millisecond {
		t.Fatal("open breaker must answer immediately")
	}
}

func TestMissDoesNotTripBreaker(t *testing.T) {
	mr := miniredis.RunT(t)
	c := newCache(redis.NewClient(&redis.Options{Addr: mr.Addr()}), opts())
	ctx := context.Background()
	for i := 0; i < breakerThreshold*3; i++ {
		if _, found, err := c.GetE(ctx, "absent"); found || err != nil {
			t.Fatalf("found=%v err=%v", found, err)
		}
	}
	if !c.Available() {
		t.Fatal("redis.Nil must not trip the breaker")
	}
}

func TestHalfOpenProbeClosesBreakerOnRecovery(t *testing.T) {
	mr := miniredis.RunT(t)
	addr := mr.Addr()
	c := newCache(redis.NewClient(&redis.Options{Addr: addr, DialTimeout: testDial, MaxRetries: -1}), opts())
	now := time.Now()
	c.now = func() time.Time { return now }
	ctx := context.Background()

	mr.Close()
	for i := 0; i < breakerThreshold; i++ {
		_, _, _ = c.GetE(ctx, "k")
	}
	if c.Available() {
		t.Fatal("breaker should be open")
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	// Still inside the cooldown: no probe, no call.
	if _, _, err := c.GetE(ctx, "k"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err %v", err)
	}
	now = now.Add(breakerCooldown + time.Second)
	c.Set(ctx, "k", "v", time.Minute) // this is the probe
	if !c.Available() {
		t.Fatal("successful probe must close the breaker")
	}
	if v, ok := c.Get(ctx, "k"); !ok || v != "v" {
		t.Fatalf("get %q %v", v, ok)
	}
}

func TestOptionsDisableRetries(t *testing.T) {
	o := mustOptions(t, "redis://127.0.0.1:1/0", Options{})
	if o.MaxRetries != -1 {
		t.Fatalf("MaxRetries = %d, want -1 (0 means the default 3 retries in go-redis v9)", o.MaxRetries)
	}
	if o.DialTimeout != DefaultDialTimeout || o.ReadTimeout != DefaultOpTimeout || o.WriteTimeout != DefaultOpTimeout {
		t.Fatalf("defaults not applied: %+v", o)
	}
}

func TestIncrFallsBackToMemoryWhenRedisDown(t *testing.T) {
	c, _ := Connect(context.Background(), "redis://127.0.0.1:1/0", opts())
	ctx := context.Background()
	for want := int64(1); want <= 3; want++ {
		if got := c.Incr(ctx, "rl:x", time.Minute); got != want {
			t.Fatalf("incr %d want %d", got, want)
		}
	}
	if c.Count(ctx, "rl:x") != 3 {
		t.Fatal("count must read the memory counter")
	}
	c.ResetCounter(ctx, "rl:x")
	if c.Count(ctx, "rl:x") != 0 {
		t.Fatal("reset must clear the memory counter")
	}
}

func TestMemCounterExpiresAndStaysBounded(t *testing.T) {
	now := time.Now()
	m := newMemCounter(100)
	m.now = func() time.Time { return now }
	if m.incr("a", time.Second) != 1 || m.incr("a", time.Second) != 2 {
		t.Fatal("counts")
	}
	now = now.Add(2 * time.Second)
	if m.incr("a", time.Second) != 1 {
		t.Fatal("window must reset after expiry")
	}
	for i := 0; i < 1000; i++ {
		m.incr(string(rune('A'+i%26))+time.Duration(i).String(), time.Hour)
	}
	if m.size() > 100 {
		t.Fatalf("map grew to %d, cap 100", m.size())
	}
}

func mustOptions(t *testing.T, url string, o Options) *redis.Options {
	t.Helper()
	ro, err := buildOptions(url, o)
	if err != nil {
		t.Fatal(err)
	}
	return ro
}
