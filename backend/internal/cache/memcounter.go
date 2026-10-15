package cache

import (
	"sort"
	"sync"
	"time"
)

type memEntry struct {
	n       int64
	expires time.Time
}

// memCounter is a bounded per-instance fixed-window counter used when Redis is
// unavailable. A window starts at the first hit and is not extended.
type memCounter struct {
	mu  sync.Mutex
	m   map[string]memEntry
	max int
	now func() time.Time
}

func newMemCounter(max int) *memCounter {
	return &memCounter{m: make(map[string]memEntry), max: max, now: time.Now}
}

func (c *memCounter) incr(key string, ttl time.Duration) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	e, ok := c.m[key]
	if ok && now.Before(e.expires) {
		e.n++
		c.m[key] = e
		return e.n
	}
	if !ok && len(c.m) >= c.max {
		c.makeRoom(now)
	}
	c.m[key] = memEntry{n: 1, expires: now.Add(ttl)}
	return 1
}

// makeRoom drops expired entries and, if still full, the oldest 10%.
func (c *memCounter) makeRoom(now time.Time) {
	for k, e := range c.m {
		if !now.Before(e.expires) {
			delete(c.m, k)
		}
	}
	if len(c.m) < c.max {
		return
	}
	type kv struct {
		k string
		t time.Time
	}
	all := make([]kv, 0, len(c.m))
	for k, e := range c.m {
		all = append(all, kv{k, e.expires})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
	drop := max(len(all)/10, 1)
	for _, x := range all[:drop] {
		delete(c.m, x.k)
	}
}

func (c *memCounter) get(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || !c.now().Before(e.expires) {
		return 0
	}
	return e.n
}

func (c *memCounter) del(key string) {
	c.mu.Lock()
	delete(c.m, key)
	c.mu.Unlock()
}

func (c *memCounter) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.m)
}
