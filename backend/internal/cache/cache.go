package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type Cache struct {
	R *redis.Client
}

func Connect(ctx context.Context, url string) (*Cache, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	c := redis.NewClient(opt)
	if err := c.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &Cache{R: c}, nil
}

func (c *Cache) Close() error { return c.R.Close() }

func (c *Cache) Get(ctx context.Context, key string) (string, bool) {
	v, err := c.R.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return v, true
}

func (c *Cache) Set(ctx context.Context, key, val string, ttl time.Duration) {
	_ = c.R.Set(ctx, key, val, ttl).Err()
}

func (c *Cache) Del(ctx context.Context, keys ...string) {
	if len(keys) > 0 {
		_ = c.R.Del(ctx, keys...).Err()
	}
}

// DelByPrefix drops every key under prefix via SCAN. Used to invalidate the
// read cache on writes (coarse but correct; cache is degradable).
func (c *Cache) DelByPrefix(ctx context.Context, prefix string) {
	var cursor uint64
	for {
		keys, next, err := c.R.Scan(ctx, cursor, prefix+"*", 200).Result()
		if err != nil {
			return
		}
		if len(keys) > 0 {
			_ = c.R.Del(ctx, keys...).Err()
		}
		if next == 0 {
			return
		}
		cursor = next
	}
}

// SetNX is used for idempotency fast-path and login rate limiting.
func (c *Cache) SetNX(ctx context.Context, key, val string, ttl time.Duration) bool {
	ok, err := c.R.SetNX(ctx, key, val, ttl).Result()
	return err == nil && ok
}

// Incr returns the new counter value; used by sliding-window rate limiter.
func (c *Cache) Incr(ctx context.Context, key string, ttl time.Duration) int64 {
	pipe := c.R.TxPipeline()
	n := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0
	}
	return n.Val()
}
