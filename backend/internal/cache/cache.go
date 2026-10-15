// Package cache is the only way to reach Redis. Redis is an optional cache:
// every operation degrades to a miss/no-op when it is disabled, unreachable or
// behind an open circuit breaker, and no call can stall a request for longer
// than the per-op timeout. Postgres is the auth authority (see internal/auth).
package cache

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	DefaultDialTimeout = 1 * time.Second
	DefaultOpTimeout   = 500 * time.Millisecond

	breakerThreshold = 3
	breakerCooldown  = 30 * time.Second
	startupPingLimit = 1500 * time.Millisecond
	scanTotalLimit   = 2 * time.Second
	memCounterMax    = 50_000
)

// ErrUnavailable means Redis is disabled or the breaker is open: no call was made.
var ErrUnavailable = errors.New("cache unavailable")

// Options tunes timeouts. Zero values take the defaults.
type Options struct {
	DialTimeout time.Duration
	OpTimeout   time.Duration
}

func (o Options) withDefaults() Options {
	if o.DialTimeout <= 0 {
		o.DialTimeout = DefaultDialTimeout
	}
	if o.OpTimeout <= 0 {
		o.OpTimeout = DefaultOpTimeout
	}
	return o
}

type Cache struct {
	r         *redis.Client // nil = disabled
	opTimeout time.Duration
	mem       *memCounter
	now       func() time.Time

	mu       sync.Mutex
	fails    int
	openTill time.Time
	probing  bool
	isOpen   bool
}

// buildOptions parses the URL and applies bounded timeouts. MaxRetries is -1:
// in go-redis v9, 0 means the default 3 retries and only -1 disables them.
func buildOptions(url string, o Options) (*redis.Options, error) {
	o = o.withDefaults()
	ro, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	ro.DialTimeout = o.DialTimeout
	ro.ReadTimeout = o.OpTimeout
	ro.WriteTimeout = o.OpTimeout
	ro.PoolTimeout = o.DialTimeout
	ro.MaxRetries = -1
	return ro, nil
}

func newCache(c *redis.Client, o Options) *Cache {
	o = o.withDefaults()
	return &Cache{r: c, opTimeout: o.OpTimeout, mem: newMemCounter(memCounterMax), now: time.Now}
}

// NewFromClient wraps an existing client (tests).
func NewFromClient(c *redis.Client) *Cache { return newCache(c, Options{}) }

// Connect never fails on reachability. An empty url yields a disabled cache; a
// failed startup ping yields a degraded cache with the breaker open. The error
// is non-nil only for an unparseable url, and the returned cache is then a
// usable disabled one.
func Connect(ctx context.Context, url string, o Options) (*Cache, error) {
	if url == "" {
		slog.Info("redis_disabled", "reason", "REDIS_URL empty")
		return newCache(nil, o), nil
	}
	ro, err := buildOptions(url, o)
	if err != nil {
		return newCache(nil, o), err
	}
	c := newCache(redis.NewClient(ro), o)
	pctx, cancel := context.WithTimeout(ctx, startupPingLimit)
	defer cancel()
	if err := c.r.Ping(pctx).Err(); err != nil {
		slog.Warn("redis_degraded_at_start", "err", err)
		c.mu.Lock()
		c.fails = breakerThreshold
		c.openTill = c.now().Add(breakerCooldown)
		c.isOpen = true
		c.mu.Unlock()
	}
	return c, nil
}

func (c *Cache) Close() error {
	if c == nil || c.r == nil {
		return nil
	}
	return c.r.Close()
}

// Enabled reports whether a Redis client is configured.
func (c *Cache) Enabled() bool { return c != nil && c.r != nil }

// Available reports whether calls are currently being attempted.
func (c *Cache) Available() bool {
	if !c.Enabled() {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fails < breakerThreshold
}

// Status is "ok", "down" or "disabled", for health output. It actively pings
// (subject to the breaker) so a recovered Redis is reported as ok.
func (c *Cache) Status() string {
	if !c.Enabled() {
		return "disabled"
	}
	if err := c.Ping(context.Background()); err != nil {
		return "down"
	}
	return "ok"
}

// allow decides whether a call may proceed. Closed: yes. Open inside the
// cooldown: no. After the cooldown exactly one caller becomes the probe.
func (c *Cache) allow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fails < breakerThreshold {
		return true
	}
	if c.now().Before(c.openTill) || c.probing {
		return false
	}
	c.probing = true
	return true
}

func (c *Cache) record(err error) {
	healthy := err == nil || errors.Is(err, redis.Nil)
	if !healthy {
		var re redis.Error
		healthy = errors.As(err, &re) // server answered (e.g. WRONGTYPE): transport is fine
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	wasProbe := c.probing
	c.probing = false
	if healthy {
		c.fails = 0
		if c.isOpen {
			c.isOpen = false
			slog.Info("redis_breaker_closed")
		}
		return
	}
	c.fails++
	if c.fails >= breakerThreshold {
		c.openTill = c.now().Add(breakerCooldown)
		if !c.isOpen || wasProbe {
			slog.Warn("redis_breaker_open", "err", err, "cooldown", breakerCooldown)
		}
		c.isOpen = true
	}
}

// do runs fn under the op timeout and the breaker. redis.Nil passes through.
func (c *Cache) do(ctx context.Context, fn func(context.Context) error) error {
	if !c.Enabled() || !c.allow() {
		return ErrUnavailable
	}
	octx, cancel := context.WithTimeout(ctx, c.opTimeout)
	defer cancel()
	err := fn(octx)
	if err != nil && ctx.Err() != nil && !errors.Is(err, redis.Nil) {
		// Caller went away: not evidence about Redis. Release a probe slot.
		c.mu.Lock()
		c.probing = false
		c.mu.Unlock()
		return err
	}
	c.record(err)
	return err
}

func (c *Cache) Ping(ctx context.Context) error {
	return c.do(ctx, func(ctx context.Context) error { return c.r.Ping(ctx).Err() })
}

// GetE distinguishes a miss (found=false, err=nil) from unavailability.
func (c *Cache) GetE(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := c.do(ctx, func(ctx context.Context) (e error) { v, e = c.r.Get(ctx, key).Result(); return })
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

// Get is the cache-only helper: any error is a miss.
func (c *Cache) Get(ctx context.Context, key string) (string, bool) {
	v, found, err := c.GetE(ctx, key)
	return v, found && err == nil
}

func (c *Cache) SetE(ctx context.Context, key, val string, ttl time.Duration) error {
	return c.do(ctx, func(ctx context.Context) error { return c.r.Set(ctx, key, val, ttl).Err() })
}

func (c *Cache) Set(ctx context.Context, key, val string, ttl time.Duration) {
	_ = c.SetE(ctx, key, val, ttl)
}

func (c *Cache) DelE(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return c.do(ctx, func(ctx context.Context) error { return c.r.Del(ctx, keys...).Err() })
}

func (c *Cache) Del(ctx context.Context, keys ...string) { _ = c.DelE(ctx, keys...) }

// DelByPrefix drops every key under prefix via SCAN (read-cache invalidation;
// coarse but correct). Bounded overall, and skipped when Redis is unavailable.
func (c *Cache) DelByPrefix(ctx context.Context, prefix string) {
	_ = c.DelByPrefixE(ctx, prefix)
}

func (c *Cache) DelByPrefixE(ctx context.Context, prefix string) error {
	if !c.Enabled() {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, scanTotalLimit)
	defer cancel()
	var cursor uint64
	for {
		var keys []string
		var next uint64
		err := c.do(ctx, func(ctx context.Context) (e error) {
			keys, next, e = c.r.Scan(ctx, cursor, prefix+"*", 200).Result()
			return
		})
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			if err := c.DelE(ctx, keys...); err != nil {
				return err
			}
		}
		if next == 0 {
			return nil
		}
		cursor = next
	}
}

// SetNX is best effort: false when Redis is unavailable.
func (c *Cache) SetNX(ctx context.Context, key, val string, ttl time.Duration) bool {
	var ok bool
	err := c.do(ctx, func(ctx context.Context) (e error) { ok, e = c.r.SetNX(ctx, key, val, ttl).Result(); return })
	return err == nil && ok
}

// IncrE is a Redis-only fixed counter (INCR + EXPIRE in one transaction).
func (c *Cache) IncrE(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	var n int64
	err := c.do(ctx, func(ctx context.Context) error {
		pipe := c.r.TxPipeline()
		cmd := pipe.Incr(ctx, key)
		pipe.Expire(ctx, key, ttl)
		if _, e := pipe.Exec(ctx); e != nil {
			return e
		}
		n = cmd.Val()
		return nil
	})
	return n, err
}

// IncrWindow is the per-request fixed-window counter (the key carries the time
// bucket): a plain INCR, plus EXPIRE only on the first hit, so a busy window costs
// one Redis command per request (Upstash bills per command). On any Redis
// failure it falls back to the in-memory window like Incr.
func (c *Cache) IncrWindow(ctx context.Context, key string, ttl time.Duration) int64 {
	var n int64
	err := c.do(ctx, func(ctx context.Context) (e error) { n, e = c.r.Incr(ctx, key).Result(); return })
	if err != nil {
		if c == nil {
			return newMemCounter(1).incr(key, ttl)
		}
		return c.mem.incr(key, ttl)
	}
	if n == 1 {
		_ = c.do(ctx, func(ctx context.Context) error { return c.r.Expire(ctx, key, ttl).Err() })
	}
	return n
}

// Incr is the login counter (the window slides: every hit refreshes the TTL
// in one transaction): Redis first, and on ANY failure a bounded
// per-instance in-memory fixed window, so limits survive a Redis outage
// (fail-open would remove login brute-force protection). With several
// instances the effective limit can be up to N times higher; accepted.
func (c *Cache) Incr(ctx context.Context, key string, ttl time.Duration) int64 {
	if n, err := c.IncrE(ctx, key, ttl); err == nil {
		return n
	}
	if c == nil {
		return newMemCounter(1).incr(key, ttl)
	}
	return c.mem.incr(key, ttl)
}

// Count reads a counter written by Incr (Redis, else memory).
func (c *Cache) Count(ctx context.Context, key string) int64 {
	if v, found, err := c.GetE(ctx, key); err == nil {
		if !found {
			return 0
		}
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	if c == nil {
		return 0
	}
	return c.mem.get(key)
}

// ResetCounter clears a counter in Redis (best effort) and in memory.
func (c *Cache) ResetCounter(ctx context.Context, key string) {
	if c == nil {
		return
	}
	c.Del(ctx, key)
	c.mem.del(key)
}
