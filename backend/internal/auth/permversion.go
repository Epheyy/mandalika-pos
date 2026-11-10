package auth

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/cache"
)

// Defaults for the rights-version lookup chain.
const (
	defaultMemoTTL  = 5 * time.Second // cross-instance "within seconds" bound
	defaultRedisTTL = 2 * time.Minute // bounds a stale or lost Redis publish
	defaultMemoMax  = 10_000          // cleared when full
	permKeyPrefix   = "authpv:"       // must NOT start with cache.ReadKeyPrefix (every write wipes that)
	permKeyDeleted  = "x"
)

// permVersionKey is the Redis key holding a user's rights version.
func permVersionKey(uid string) string { return permKeyPrefix + uid }

// VersionLoader reads the authoritative rights version. exists=false means the
// user is gone (a definitive answer); an error means no verdict.
type VersionLoader func(ctx context.Context, uid string) (v int64, exists bool, err error)

// LoadPermVersion is the Postgres primary-key read behind the lookup chain.
func (s *Store) LoadPermVersion(ctx context.Context, uid string) (int64, bool, error) {
	var v int64
	err := s.Pool.QueryRow(ctx, `SELECT perm_version FROM users WHERE id=$1`, uid).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return v, true, nil
}

// PermVersionOptions tunes PermVersions; zero values take the defaults.
type PermVersionOptions struct {
	MemoTTL, RedisTTL time.Duration
	MemoMax           int
	Now               func() time.Time
}

type memoEntry struct {
	v       int64
	exists  bool
	expires time.Time
}

// PermVersions answers "what is this user's current rights version?" through an
// in-process memo, then Redis, then Postgres. See RequireAuth for how it is used.
type PermVersions struct {
	c    *cache.Cache
	load VersionLoader
	opts PermVersionOptions

	mu     sync.Mutex
	memo   map[string]memoEntry
	flight map[string]*flightCall // in-flight memo-miss lookups, one per user
}

// flightCall is one in-flight lookup that concurrent callers for the same user share.
type flightCall struct {
	done   chan struct{}
	v      int64
	exists bool
	err    error
}

// fetchTimeout bounds a shared lookup. It runs detached from any one request, so the
// caller that started it aborting cannot fail the callers waiting on it.
const fetchTimeout = 3 * time.Second

func NewPermVersions(c *cache.Cache, load VersionLoader, opts PermVersionOptions) *PermVersions {
	if opts.MemoTTL <= 0 {
		opts.MemoTTL = defaultMemoTTL
	}
	if opts.RedisTTL <= 0 {
		opts.RedisTTL = defaultRedisTTL
	}
	if opts.MemoMax <= 0 {
		opts.MemoMax = defaultMemoMax
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &PermVersions{c: c, load: load, opts: opts, memo: map[string]memoEntry{}, flight: map[string]*flightCall{}}
}

func (p *PermVersions) memoLen() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.memo)
}

// putLocked stores an entry, clearing the memo first when it is full. Versions
// only grow, so a fresh entry is never replaced by a lower one and a tombstone is
// never revived: a slow load that started before a commit cannot undo its publish.
func (p *PermVersions) putLocked(uid string, v int64, exists bool) {
	cur, ok := p.memo[uid]
	if ok && p.opts.Now().Before(cur.expires) {
		if !cur.exists {
			exists, v = false, 0
		} else if exists && v < cur.v {
			v = cur.v
		}
	}
	if !ok && len(p.memo) >= p.opts.MemoMax {
		p.memo = map[string]memoEntry{}
	}
	p.memo[uid] = memoEntry{v: v, exists: exists, expires: p.opts.Now().Add(p.opts.MemoTTL)}
}

func (p *PermVersions) memoize(uid string, v int64, exists bool) {
	p.mu.Lock()
	p.putLocked(uid, v, exists)
	p.mu.Unlock()
}

// Current returns the user's rights version. An error means no verdict (Postgres
// was needed and failed): the caller must not treat it as a revocation.
func (p *PermVersions) Current(ctx context.Context, uid string) (int64, bool, error) {
	p.mu.Lock()
	if e, ok := p.memo[uid]; ok && p.opts.Now().Before(e.expires) {
		p.mu.Unlock()
		return e.v, e.exists, nil
	}
	p.mu.Unlock()

	return p.shared(ctx, uid)
}

// shared runs the Redis-then-Postgres lookup once per user at a time: a burst of requests
// after a memo expiry costs one Postgres read per instance, not one per request.
func (p *PermVersions) shared(ctx context.Context, uid string) (int64, bool, error) {
	p.mu.Lock()
	if c, ok := p.flight[uid]; ok {
		p.mu.Unlock()
		select {
		case <-c.done:
			return c.v, c.exists, c.err
		case <-ctx.Done():
			return 0, false, ctx.Err()
		}
	}
	c := &flightCall{done: make(chan struct{})}
	p.flight[uid] = c
	p.mu.Unlock()

	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
	c.v, c.exists, c.err = p.fetch(fctx, uid)
	cancel()
	p.mu.Lock()
	delete(p.flight, uid)
	p.mu.Unlock()
	close(c.done)
	return c.v, c.exists, c.err
}

// fetch reads Redis, then Postgres, and memoizes the answer.
func (p *PermVersions) fetch(ctx context.Context, uid string) (int64, bool, error) {
	key := permVersionKey(uid)
	if raw, found, err := p.c.GetE(ctx, key); err == nil && found {
		if raw == permKeyDeleted {
			p.memoize(uid, 0, false)
			return 0, false, nil
		}
		if v, perr := strconv.ParseInt(raw, 10, 64); perr == nil {
			p.memoize(uid, v, true)
			return v, true, nil
		}
		// An unparseable value counts as a miss.
	}

	v, exists, err := p.load(ctx, uid)
	if err != nil {
		return 0, false, err
	}
	p.memoize(uid, v, exists)
	val := permKeyDeleted
	if exists {
		val = strconv.FormatInt(v, 10)
	}
	p.c.SetNX(ctx, key, val, p.opts.RedisTTL) // best effort; a publish always wins
	return v, exists, nil
}

// Observe records that a token with version pv was accepted. Tokens are only
// minted from a database read, so the database has reached at least pv: the memo
// is raised, never lowered, and a deleted entry is never revived.
func (p *PermVersions) Observe(uid string, pv int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.memo[uid]
	switch {
	case !ok || !p.opts.Now().Before(e.expires):
		p.putLocked(uid, pv, true)
	case e.exists && pv > e.v:
		e.v = pv
		p.memo[uid] = e
	}
}

// Publish records a committed rights change: memo first, then Redis (SET, so it
// beats any stale SETNX populate).
func (p *PermVersions) Publish(ctx context.Context, uid string, v int64) {
	p.memoize(uid, v, true)
	p.publishRedis(ctx, uid, strconv.FormatInt(v, 10))
}

// PublishDeleted records that the user is gone (a tombstone).
func (p *PermVersions) PublishDeleted(ctx context.Context, uid string) {
	p.memoize(uid, 0, false)
	p.publishRedis(ctx, uid, permKeyDeleted)
}

func (p *PermVersions) publishRedis(ctx context.Context, uid, val string) {
	if err := p.c.SetE(ctx, permVersionKey(uid), val, p.opts.RedisTTL); err != nil {
		slog.Warn("perm_version_publish_failed", "user", uid, "err", err)
	}
}

// Revoked reports whether a token carrying tokenPV must be refused. It refuses
// only a version below the current one or a missing user: a newer token proves
// the database moved on, and plain inequality would loop refreshes whenever a
// Redis publish was lost.
func Revoked(tokenPV, current int64, exists bool) bool {
	return !exists || tokenPV < current
}
