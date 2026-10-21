package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/handlers"
	"github.com/mandalika/pos-backend/internal/rules"
	"github.com/mandalika/pos-backend/internal/server"
)

// TestAuthAuthorityPostgres (A33/A07): Postgres is the refresh-token authority
// and Redis is an optional cache. The FULL router is driven over HTTP against a
// real PostgreSQL, with Redis refused, blackholed, disabled and healthy.
//
// Every simulated tablet / goroutine sends its own X-Forwarded-For (TEST-NET,
// then the IPv6 documentation prefix) so the strict per-IP `auth` limiter is
// never loosened or tripped by the gate itself; only case 1 deliberately reuses
// one IP to prove the in-memory limiter. No subtest may skip (the gate treats a
// skip as a failure).
func TestAuthAuthorityPostgres(t *testing.T) {
	pool, ctx := handlers.GatePool(t, "AU", 56455)
	g := newAUGate(t, pool, ctx)

	t.Run("1 redis down: refused", func(t *testing.T) { g.redisDown(t, g.refusedCache(t), "refused") })
	t.Run("1 redis down: blackholed", func(t *testing.T) { g.redisDown(t, g.blackholeCache(t), "blackhole") })
	t.Run("1 redis down: disabled", func(t *testing.T) { g.redisDown(t, g.disabledCache(t), "disabled") })
	t.Run("2 concurrent refresh", g.concurrentRefresh)
	t.Run("3 lost response", g.lostResponse)
	t.Run("4 logout", g.logout)
	t.Run("5 reset", g.reset)
	t.Run("6 adoption", g.adoption)
	t.Run("7 expired foreign deleted", g.expiredForeignDeleted)
	t.Run("8 startup without redis", g.startupWithoutRedis)
	t.Run("9 old revision compatibility", g.oldRevision)
	t.Run("10 cleanup", g.cleanup)
}

const (
	auOutlet  = "00000000-0000-4000-8f00-000000000001"
	auProduct = "00000000-0000-4000-8f00-000000000021"
	auDevice  = "audev"
	auPW      = "S3cret-au-pass-0"
)

type auGate struct {
	t      *testing.T
	pool   *pgxpool.Pool
	ctx    context.Context
	cfg    *config.Config
	store  *auth.Store
	hash   string
	ipSeq  atomic.Int64
	userN  atomic.Int64
	orderN atomic.Int64
}

func newAUGate(t *testing.T, pool *pgxpool.Pool, ctx context.Context) *auGate {
	t.Helper()
	g := &auGate{t: t, pool: pool, ctx: ctx, store: auth.NewStore(pool)}
	g.cfg = &config.Config{
		AccessSecret:     []byte("AU-SYNTHETIC-ACCESS-KEY-NOT-A-PRODUCTION-SECRET"),
		RefreshSecret:    []byte("AU-SYNTHETIC-REFRESH-KEY-NOT-A-PRODUCTION-SECRET"),
		AccessTTL:        15 * time.Minute,
		RefreshTTL:       24 * time.Hour,
		RateLimitRPS:     1000,
		TrustedProxyHops: 1,
		CORSOrigins:      []string{"http://localhost"},
	}
	h, err := rules.HashPassword(auPW)
	if err != nil {
		t.Fatal(err)
	}
	g.hash = h
	g.exec(`INSERT INTO outlets(id,name) VALUES($1,'AU outlet')`, auOutlet)
	g.exec(`INSERT INTO products(id,name) VALUES($1,'AU product')`, auProduct)
	g.exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,100000,'AU')`, auProduct)
	g.exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',100000)`, auOutlet, auProduct)
	return g
}

// ---- infrastructure -------------------------------------------------------

func (g *auGate) exec(sql string, args ...any) {
	g.t.Helper()
	if _, err := g.pool.Exec(g.ctx, sql, args...); err != nil {
		g.t.Fatal(err)
	}
}

func (g *auGate) count(sql string, args ...any) (n int) {
	g.t.Helper()
	if err := g.pool.QueryRow(g.ctx, sql, args...).Scan(&n); err != nil {
		g.t.Fatal(err)
	}
	return
}

func (g *auGate) rowJSON(jti string) string {
	g.t.Helper()
	var s string
	if err := g.pool.QueryRow(g.ctx, `SELECT to_jsonb(x)::text FROM refresh_tokens x WHERE jti=$1`, jti).Scan(&s); err != nil {
		g.t.Fatal(err)
	}
	return s
}

func (g *auGate) live(userID string) int {
	g.t.Helper()
	return g.count(`SELECT count(*) FROM refresh_tokens WHERE user_id=$1 AND NOT revoked AND expires_at>now()`, userID)
}

// nextIP returns a distinct client address per call (TEST-NET-2, TEST-NET-3,
// then unique IPv6 documentation /64s), so each simulated tablet has its own
// rate-limit bucket.
func (g *auGate) nextIP() string {
	i := int(g.ipSeq.Add(1))
	switch {
	case i <= 254:
		return fmt.Sprintf("198.51.100.%d", i)
	case i <= 508:
		return fmt.Sprintf("203.0.113.%d", i-254)
	default:
		return fmt.Sprintf("2001:db8:%x::1", i)
	}
}

func (g *auGate) router(c *cache.Cache) http.Handler {
	return server.New(g.cfg, &db.DB{Pool: g.pool}, c, nil)
}

func (g *auGate) miniCache(t *testing.T) (*cache.Cache, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	return cache.NewFromClient(rc), mr
}

func (g *auGate) refusedCache(t *testing.T) *cache.Cache {
	t.Helper()
	c, err := cache.Connect(g.ctx, "redis://127.0.0.1:1/0", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (g *auGate) blackholeCache(t *testing.T) *cache.Cache {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = conn.Close() }) // accept and never reply
		}
	}()
	c, err := cache.Connect(g.ctx, "redis://"+ln.Addr().String()+"/0", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (g *auGate) disabledCache(t *testing.T) *cache.Cache {
	t.Helper()
	c, err := cache.Connect(g.ctx, "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// newUser inserts a synthetic user (cashier at auOutlet unless role=admin).
func (g *auGate) newUser(role string) (id, email string) {
	g.t.Helper()
	n := g.userN.Add(1)
	id = fmt.Sprintf("00000000-0000-4000-8f01-%012d", n)
	email = fmt.Sprintf("au%d@example.invalid", n)
	var outlet any = auOutlet
	if role == "admin" {
		outlet = nil
	}
	g.exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,$3,'AU user',$4,$5)`,
		id, email, g.hash, role, outlet)
	return
}

// call performs one request with its own client IP and asserts bounded latency.
func (g *auGate) call(srv http.Handler, method, path, body, bearer, ip string) *httptest.ResponseRecorder {
	g.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.1:4321"
	r.Header.Set("X-Forwarded-For", ip)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	start := time.Now()
	srv.ServeHTTP(w, r)
	if d := time.Since(start); d > 2*time.Second {
		g.t.Errorf("%s %s took %v (> 2s)", method, path, d)
	}
	return w
}

type tokenPair struct{ Access, Refresh string }

func decodePair(g *auGate, w *httptest.ResponseRecorder) tokenPair {
	g.t.Helper()
	var env struct {
		Data struct {
			Access  string `json:"access"`
			Refresh string `json:"refresh"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		g.t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return tokenPair{env.Data.Access, env.Data.Refresh}
}

func (g *auGate) login(srv http.Handler, email, pw string) (tokenPair, int) {
	g.t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": pw})
	w := g.call(srv, "POST", "/api/v1/auth/login", string(body), "", g.nextIP())
	if w.Code != 200 {
		return tokenPair{}, w.Code
	}
	return decodePair(g, w), w.Code
}

func (g *auGate) mustLogin(srv http.Handler, email string) tokenPair {
	g.t.Helper()
	p, code := g.login(srv, email, auPW)
	if code != 200 {
		g.t.Fatalf("login %s: %d", email, code)
	}
	return p
}

func (g *auGate) refresh(srv http.Handler, token string) (tokenPair, int) {
	g.t.Helper()
	body, _ := json.Marshal(map[string]string{"refresh": token})
	w := g.call(srv, "POST", "/api/v1/auth/refresh", string(body), "", g.nextIP())
	// The client logs out on any other non-OK status: enforce the contract.
	switch c := w.Code; {
	case c == 200, c == 401, c == 429, c >= 500:
	default:
		g.t.Errorf("refresh answered %d, outside 200/401/429/5xx", c)
	}
	if w.Code != 200 {
		return tokenPair{}, w.Code
	}
	return decodePair(g, w), w.Code
}

func (g *auGate) logoutReq(srv http.Handler, token string) int {
	g.t.Helper()
	body, _ := json.Marshal(map[string]string{"refresh": token})
	return g.call(srv, "POST", "/api/v1/auth/logout", string(body), "", g.nextIP()).Code
}

func (g *auGate) jti(token string) string {
	g.t.Helper()
	rc, err := auth.ParseRefresh(g.cfg.RefreshSecret, token)
	if err != nil {
		g.t.Fatalf("parse refresh: %v", err)
	}
	return rc.ID
}

func (g *auGate) parallel(n int, fn func(i int)) {
	var ready, wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		ready.Add(1)
		wg.Add(1)
		go func() {
			defer wg.Done()
			ready.Done()
			<-start
			fn(i)
		}()
	}
	ready.Wait()
	close(start)
	wg.Wait()
}

func (g *auGate) orderItem(name string, userID string) map[string]any {
	n := g.orderN.Add(1)
	return map[string]any{
		"type": "order", "idempotencyKey": auDevice + ":" + name,
		"envelope": map[string]any{"v": 1, "outletId": auOutlet, "userId": userID, "deviceId": auDevice,
			"capturedAt": time.Now().UTC().Format(time.RFC3339)},
		"payload": map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8f02-%012d", n), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": auProduct, "productName": "AU product", "variantSize": "110ml",
				"price": 100000, "quantity": 1, "subtotal": 100000}},
		},
	}
}

func (g *auGate) adminToken(srv http.Handler) (id string, token string) {
	g.t.Helper()
	id, email := g.newUser("admin")
	return id, g.mustLogin(srv, email).Access
}

func (g *auGate) resetPassword(srv http.Handler, adminTok, userID, pw string) int {
	g.t.Helper()
	body, _ := json.Marshal(map[string]string{"password": pw})
	// Not behind the strict auth bucket, but keep every call on its own IP anyway.
	return g.call(srv, "POST", "/api/v1/users/"+userID+"/reset-password", string(body), adminTok, g.nextIP()).Code
}

// ---- case 1: Redis down ---------------------------------------------------

func (g *auGate) redisDown(t *testing.T, c *cache.Cache, mode string) {
	srv := g.router(c)
	userID, email := g.newUser("cashier")

	pair := g.mustLogin(srv, email)
	next, code := g.refresh(srv, pair.Refresh)
	if code != 200 || next.Refresh == "" {
		t.Fatalf("[%s] refresh with Redis down: %d", mode, code)
	}
	if g.live(userID) != 1 {
		t.Fatalf("[%s] want exactly one live session, got %d", mode, g.live(userID))
	}

	if w := g.call(srv, "GET", "/api/v1/sync/pull", "", next.Access, g.nextIP()); w.Code != 200 {
		t.Fatalf("[%s] sync/pull: %d %s", mode, w.Code, w.Body)
	}
	raw, _ := json.Marshal(map[string]any{"items": []any{g.orderItem("down-"+mode, userID)}})
	w := g.call(srv, "POST", "/api/v1/sync/batch", string(raw), next.Access, g.nextIP())
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("[%s] sync/batch: %d %s", mode, w.Code, w.Body)
	}
	if n := g.count(`SELECT count(*) FROM orders WHERE idempotency_key=$1`, auDevice+":down-"+mode); n != 1 {
		t.Fatalf("[%s] order not persisted (%d)", mode, n)
	}

	h := g.call(srv, "GET", "/healthz", "", "", g.nextIP())
	var env struct {
		Data map[string]string `json:"data"`
	}
	_ = json.Unmarshal(h.Body.Bytes(), &env)
	wantRedis := map[string]string{"refused": "down", "blackhole": "down", "disabled": "disabled"}[mode]
	if h.Code != 200 || env.Data["status"] != "degraded" || env.Data["db"] != "ok" || env.Data["redis"] != wantRedis {
		t.Fatalf("[%s] healthz %d %v", mode, h.Code, env.Data)
	}
	if r := g.call(srv, "GET", "/readyz", "", "", g.nextIP()); r.Code != 200 {
		t.Fatalf("[%s] readyz %d", mode, r.Code)
	}

	// The limiter must still work from memory: one IP, wrong passwords, a
	// dedicated user. Requests 1-10 pass the bucket (401), the 11th is 429.
	_, lim := g.newUser("cashier")
	ip := g.nextIP()
	body, _ := json.Marshal(map[string]string{"email": lim, "password": "wrong-password-1"})
	for i := 1; i <= 10; i++ {
		if w := g.call(srv, "POST", "/api/v1/auth/login", string(body), "", ip); w.Code != 401 {
			t.Fatalf("[%s] attempt %d: %d want 401", mode, i, w.Code)
		}
	}
	if w := g.call(srv, "POST", "/api/v1/auth/login", string(body), "", ip); w.Code != 429 {
		t.Fatalf("[%s] attempt 11: %d want 429 from the in-memory limiter", mode, w.Code)
	}
}

// ---- case 2: concurrent refresh -------------------------------------------

func (g *auGate) concurrentRefresh(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	x := g.mustLogin(srv, email)
	xJTI := g.jti(x.Refresh)

	const n = 20
	codes := make([]int, n)
	jtis := make([]string, n)
	g.parallel(n, func(i int) {
		p, code := g.refresh(srv, x.Refresh)
		codes[i] = code
		if code == 200 {
			jtis[i] = g.jti(p.Refresh)
		}
	})
	for i := 0; i < n; i++ {
		if codes[i] != 200 {
			t.Fatalf("goroutine %d: %d (every response must be 200, no 5xx)", i, codes[i])
		}
		if jtis[i] != jtis[0] {
			t.Fatalf("goroutine %d got jti %s, others %s: the family forked", i, jtis[i], jtis[0])
		}
	}
	var revoked bool
	var family string
	if err := g.pool.QueryRow(g.ctx, `SELECT revoked, COALESCE(family_id,jti)::text FROM refresh_tokens WHERE jti=$1`, xJTI).Scan(&revoked, &family); err != nil || !revoked {
		t.Fatalf("X must be revoked: %v %v", revoked, err)
	}
	if rows := g.count(`SELECT count(*) FROM refresh_tokens WHERE family_id=$1`, family); rows != 2 {
		t.Fatalf("family has %d rows, want exactly 2", rows)
	}
	if live := g.live(userID); live != 1 {
		t.Fatalf("want one live head, got %d", live)
	}
}

// ---- case 3: lost response ------------------------------------------------

func (g *auGate) lostResponse(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	x := g.mustLogin(srv, email)

	y, code := g.refresh(srv, x.Refresh) // response "lost"
	if code != 200 {
		t.Fatalf("X->Y %d", code)
	}
	yJTI := g.jti(y.Refresh)
	yBefore := g.rowJSON(yJTI)

	logs := captureLogs(t)
	again, code := g.refresh(srv, x.Refresh)
	out := logs()
	if !strings.Contains(out, "refresh_remint") || !strings.Contains(out, "age=") {
		t.Fatalf("a re-mint must log refresh_remint with the predecessor's age, got %q", out)
	}
	if strings.Contains(out, x.Refresh) || strings.Contains(out, y.Refresh) || strings.Contains(out, xJTIOf(g, x)) {
		t.Fatal("refresh_remint must not log token values")
	}
	if code != 200 || g.jti(again.Refresh) != yJTI {
		t.Fatalf("replay of X must re-mint Y: %d", code)
	}
	if again.Refresh != y.Refresh {
		t.Fatal("the re-minted refresh token must be byte-identical")
	}
	if g.rowJSON(yJTI) != yBefore {
		t.Fatal("re-mint must not write: Y's row changed")
	}

	z, code := g.refresh(srv, y.Refresh)
	if code != 200 {
		t.Fatalf("Y->Z %d", code)
	}
	zJTI := g.jti(z.Refresh)
	zAgain, code := g.refresh(srv, y.Refresh)
	if code != 200 || g.jti(zAgain.Refresh) != zJTI {
		t.Fatalf("replay of Y must re-mint Z: %d", code)
	}
	if _, code := g.refresh(srv, x.Refresh); code != 401 {
		t.Fatalf("X is deep reuse now: %d want 401", code)
	}
	if g.live(userID) != 1 {
		t.Fatal("deep reuse must not revoke the family: Z must stay live")
	}
	if _, code := g.refresh(srv, z.Refresh); code != 200 {
		t.Fatalf("refresh with Z: %d", code)
	}
}

// captureLogs routes slog to a buffer until the returned func is called, which
// restores the previous logger and returns what was logged.
func captureLogs(t *testing.T) func() string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &mu, w: &buf}, nil)))
	restored := false
	restore := func() {
		if !restored {
			restored = true
			slog.SetDefault(prev)
		}
	}
	t.Cleanup(restore)
	return func() string {
		restore()
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func xJTIOf(g *auGate, p tokenPair) string { return g.jti(p.Refresh) }

// ---- case 4: logout -------------------------------------------------------

func (g *auGate) logout(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	x := g.mustLogin(srv, email)
	y, code := g.refresh(srv, x.Refresh)
	if code != 200 {
		t.Fatalf("X->Y %d", code)
	}
	if g.logoutReq(srv, y.Refresh) != 200 {
		t.Fatal("logout must answer 200")
	}
	if g.live(userID) != 0 {
		t.Fatal("logout must revoke the whole family")
	}
	for name, tok := range map[string]string{"X": x.Refresh, "Y": y.Refresh} {
		if _, code := g.refresh(srv, tok); code != 401 {
			t.Fatalf("replay of %s after logout: %d want 401", name, code)
		}
	}

	// Owner decision 2026-10-16: logout with ANY token of the session ends the
	// whole session, including a stale token whose successors are long revoked.
	{
		uid, mail := g.newUser("cashier")
		a := g.mustLogin(srv, mail)
		b, _ := g.refresh(srv, a.Refresh)
		cTok, code := g.refresh(srv, b.Refresh)
		if code != 200 {
			t.Fatalf("B->C %d", code)
		}
		if g.logoutReq(srv, a.Refresh) != 200 {
			t.Fatal("logout with a stale token must answer 200")
		}
		if g.live(uid) != 0 {
			t.Fatalf("a stale-token logout must end the whole session, live=%d", g.live(uid))
		}
		if _, code := g.refresh(srv, cTok.Refresh); code != 401 {
			t.Fatalf("the former live head must be refused after a stale-token logout: %d", code)
		}
	}
	// A token whose row is revoked AND already expired (not yet swept) still
	// belongs to the family: logging out with it ends the session.
	{
		uid, mail := g.newUser("cashier")
		a := g.mustLogin(srv, mail)
		b, _ := g.refresh(srv, a.Refresh)
		g.exec(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE jti=$1`, g.jti(a.Refresh))
		if g.logoutReq(srv, a.Refresh) != 200 {
			t.Fatal("logout must answer 200")
		}
		if g.live(uid) != 0 {
			t.Fatalf("an expired-but-unswept family token must still end the session, live=%d", g.live(uid))
		}
		if _, code := g.refresh(srv, b.Refresh); code != 401 {
			t.Fatalf("refresh after that logout: %d", code)
		}
	}
	// A token that belongs to a different user's row must not touch that family.
	{
		victim, vmail := g.newUser("cashier")
		v := g.mustLogin(srv, vmail)
		attacker, _ := g.newUser("cashier")
		forged, err := auth.SignRefresh(g.cfg.RefreshSecret, attacker, g.jti(v.Refresh), time.Now().Truncate(time.Second), time.Now().Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if g.logoutReq(srv, forged) != 200 {
			t.Fatal("logout must answer 200")
		}
		if g.live(victim) != 1 {
			t.Fatal("a token claiming another user must not revoke that user's family")
		}
	}
	// ...but the direct predecessor of a live head could still re-mint it, so
	// logging out with it revokes the whole family.
	{
		uid, mail := g.newUser("cashier")
		a := g.mustLogin(srv, mail)
		if _, code := g.refresh(srv, a.Refresh); code != 200 {
			t.Fatalf("A->B %d", code)
		}
		if g.logoutReq(srv, a.Refresh) != 200 {
			t.Fatal("logout must answer 200")
		}
		if g.live(uid) != 0 {
			t.Fatalf("logout with the direct predecessor must revoke the family, live=%d", g.live(uid))
		}
	}

	// Logout racing a rotation of the same token: nothing may stay live.
	for i := 0; i < 30; i++ {
		uid, mail := g.newUser("cashier")
		tok := g.mustLogin(srv, mail)
		g.parallel(2, func(k int) {
			if k == 0 {
				g.refresh(srv, tok.Refresh)
			} else {
				g.logoutReq(srv, tok.Refresh)
			}
		})
		if live := g.live(uid); live != 0 {
			t.Fatalf("iteration %d: %d live rows after logout raced a refresh", i, live)
		}
	}
}

// ---- case 5: reset --------------------------------------------------------

func (g *auGate) reset(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	_, adminTok := g.adminToken(srv)

	userID, email := g.newUser("cashier")
	x := g.mustLogin(srv, email)
	y, code := g.refresh(srv, x.Refresh)
	if code != 200 {
		t.Fatalf("X->Y %d", code)
	}
	newPW := "S3cret-au-reset-1"
	if code := g.resetPassword(srv, adminTok, userID, newPW); code != 204 {
		t.Fatalf("reset %d", code)
	}
	for name, tok := range map[string]string{"X": x.Refresh, "Y": y.Refresh} {
		if _, code := g.refresh(srv, tok); code != 401 {
			t.Fatalf("%s after reset: %d want 401", name, code)
		}
	}
	if g.live(userID) != 0 {
		t.Fatal("reset must leave no live session")
	}
	if _, code := g.login(srv, email, auPW); code != 401 {
		t.Fatalf("old password after reset: %d", code)
	}
	if _, code := g.login(srv, email, newPW); code != 200 {
		t.Fatalf("new password login: %d", code)
	}

	// Rotation racing a reset: afterwards 0 live rows, and any token the racing
	// refresh returned is refused on its next use.
	racer, racerMail := g.newUser("cashier")
	pw := auPW
	for i := 0; i < 30; i++ {
		tok, code := g.login(srv, racerMail, pw)
		if code != 200 {
			t.Fatalf("iteration %d login %d", i, code)
		}
		next := fmt.Sprintf("S3cret-au-race-%d", i)
		var got tokenPair
		var rcode, resetCode int
		g.parallel(2, func(k int) {
			if k == 0 {
				got, rcode = g.refresh(srv, tok.Refresh)
			} else {
				resetCode = g.resetPassword(srv, adminTok, racer, next)
			}
		})
		if resetCode != 204 {
			t.Fatalf("iteration %d reset %d", i, resetCode)
		}
		pw = next
		if live := g.live(racer); live != 0 {
			t.Fatalf("iteration %d: %d live rows after reset raced a rotation", i, live)
		}
		if rcode == 200 {
			if _, again := g.refresh(srv, got.Refresh); again != 401 {
				t.Fatalf("iteration %d: a token returned during the race was accepted afterwards (%d)", i, again)
			}
		}
	}

	// Login racing a reset: authenticate, reset, then issue must be refused.
	lu, lmail := g.newUser("cashier")
	u, verified, err := g.store.Authenticate(g.ctx, lmail, auPW)
	if err != nil {
		t.Fatal(err)
	}
	newHash, _ := rules.HashPassword("S3cret-au-login-race")
	if _, err := g.store.ResetPassword(g.ctx, lu, newHash); err != nil {
		t.Fatal(err)
	}
	iat := time.Now().Truncate(time.Second)
	sess := auth.Session{JTI: "00000000-0000-4000-8f03-000000000001", IssuedAt: iat, ExpiresAt: iat.Add(time.Hour)}
	if err := g.store.IssueSession(g.ctx, u, verified, sess); !errors.Is(err, auth.ErrCredentialsChanged) {
		t.Fatalf("issue after a concurrent reset: %v, want ErrCredentialsChanged", err)
	}
	if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, sess.JTI) != 0 {
		t.Fatal("a refused issue must not leave a row")
	}
}

// ---- case 6: adoption -----------------------------------------------------

func (g *auGate) legacyToken(userID, jti string, iat time.Time) string {
	g.t.Helper()
	// iat is typically an hour in the past: keep the token alive well past now.
	tok, err := auth.SignRefresh(g.cfg.RefreshSecret, userID, jti, iat, iat.Add(3*time.Hour))
	if err != nil {
		g.t.Fatal(err)
	}
	return tok
}

func (g *auGate) adoption(t *testing.T) {
	c, mr := g.miniCache(t)
	srv := g.router(c)
	iat := time.Now().Add(-time.Hour).Truncate(time.Second)

	t.Run("redis-only token is adopted", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000001"
		mr.Set("refresh:"+j, userID)
		next, code := g.refresh(srv, g.legacyToken(userID, j, iat))
		if code != 200 {
			t.Fatalf("adoption %d", code)
		}
		var family string
		var revoked bool
		if err := g.pool.QueryRow(g.ctx, `SELECT family_id::text, revoked FROM refresh_tokens WHERE jti=$1`, j).Scan(&family, &revoked); err != nil || family != j || !revoked {
			t.Fatalf("adopted row: family=%s revoked=%v err=%v", family, revoked, err)
		}
		if _, code := g.refresh(srv, next.Refresh); code != 200 {
			t.Fatalf("successor refresh %d", code)
		}
	})
	t.Run("reset marker newer than iat", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000002"
		mr.Set("refresh:"+j, userID)
		mr.Set("refresh_revoked_before:"+userID, fmt.Sprint(iat.Unix()+5))
		if _, code := g.refresh(srv, g.legacyToken(userID, j, iat)); code != 401 {
			t.Fatalf("%d want 401", code)
		}
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, j) != 0 {
			t.Fatal("a refused adoption must not create a row")
		}
	})
	t.Run("postgres reset marker newer than iat", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000003"
		mr.Set("refresh:"+j, userID)
		g.exec(`UPDATE users SET refresh_revoked_before=$2 WHERE id=$1`, userID, iat.Add(time.Minute))
		if _, code := g.refresh(srv, g.legacyToken(userID, j, iat)); code != 401 {
			t.Fatalf("%d want 401", code)
		}
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, j) != 0 {
			t.Fatal("a refused adoption must not create a row")
		}
	})
	t.Run("redis key present but PG row revoked is never revived", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000004"
		g.exec(`INSERT INTO refresh_tokens(jti,user_id,family_id,created_at,expires_at,revoked,revoked_at,revoke_reason)
		        VALUES($1,$2,$1,$3,$4,true,now(),'logout')`, j, userID, iat, iat.Add(time.Hour*3))
		mr.Set("refresh:"+j, userID) // a Redis DEL that failed
		before := g.rowJSON(j)
		if _, code := g.refresh(srv, g.legacyToken(userID, j, iat)); code != 401 {
			t.Fatalf("%d want 401", code)
		}
		if g.rowJSON(j) != before {
			t.Fatal("the revoked row must be byte-for-byte unchanged")
		}
		if g.live(userID) != 0 {
			t.Fatal("nothing may become live")
		}
	})
	t.Run("redis key present but PG row expired is never revived", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000005"
		g.exec(`INSERT INTO refresh_tokens(jti,user_id,family_id,created_at,expires_at) VALUES($1,$2,$1,$3,now() - interval '1 minute')`,
			j, userID, iat)
		mr.Set("refresh:"+j, userID)
		before := g.rowJSON(j)
		tok, _ := auth.SignRefresh(g.cfg.RefreshSecret, userID, j, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
		if _, code := g.refresh(srv, tok); code != 401 {
			t.Fatalf("%d want 401", code)
		}
		if g.rowJSON(j) != before {
			t.Fatal("the expired row must be unchanged")
		}
	})
	t.Run("no row and redis down is 503", func(t *testing.T) {
		down := g.router(g.refusedCache(t))
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f04-000000000006"
		if _, code := g.refresh(down, g.legacyToken(userID, j, iat)); code != 503 {
			t.Fatalf("%d want 503 (no verdict, session kept)", code)
		}
		disabled := g.router(g.disabledCache(t))
		if _, code := g.refresh(disabled, g.legacyToken(userID, j, iat)); code != 503 {
			t.Fatalf("disabled redis: %d want 503", code)
		}
	})
	t.Run("no row and no redis key is 401", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		if _, code := g.refresh(srv, g.legacyToken(userID, "00000000-0000-4000-8f04-000000000007", iat)); code != 401 {
			t.Fatalf("%d want 401", code)
		}
	})
	// Logout racing the adoption of a rowless legacy token: the end state must be
	// "no live row", whichever wins (logout inserts a revoked tombstone).
	t.Run("logout racing adoption of a legacy token", func(t *testing.T) {
		for round := 0; round < 25; round++ {
			userID, _ := g.newUser("cashier")
			j := fmt.Sprintf("00000000-0000-4000-8f0a-%012d", round)
			mr.Set("refresh:"+j, userID)
			tok := g.legacyToken(userID, j, iat)
			var rcode, lcode int
			g.parallel(2, func(k int) {
				if k == 0 {
					_, rcode = g.refresh(srv, tok)
				} else {
					lcode = g.logoutReq(srv, tok)
				}
			})
			if lcode != 200 || (rcode != 200 && rcode != 401) {
				t.Fatalf("round %d: logout %d refresh %d", round, lcode, rcode)
			}
			if live := g.live(userID); live != 0 {
				t.Fatalf("round %d: %d live rows after logout raced an adoption (refresh=%d)", round, live, rcode)
			}
		}
	})
	t.Run("logout of a rowless legacy token leaves a revoked tombstone", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f0b-000000000001"
		mr.Set("refresh:"+j, userID)
		tok := g.legacyToken(userID, j, iat)
		if g.logoutReq(srv, tok) != 200 {
			t.Fatal("logout must answer 200")
		}
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1 AND revoked AND revoke_reason='logout'`, j) != 1 {
			t.Fatal("expected one revoked tombstone row")
		}
		if _, code := g.refresh(srv, tok); code != 401 {
			t.Fatalf("a logged-out legacy token must be refused: %d", code)
		}
	})
	t.Run("logout of a rowless token without a redis key writes nothing", func(t *testing.T) {
		userID, _ := g.newUser("cashier")
		const j = "00000000-0000-4000-8f0b-000000000002"
		if g.logoutReq(srv, g.legacyToken(userID, j, iat)) != 200 {
			t.Fatal("logout must answer 200")
		}
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, j) != 0 {
			t.Fatal("no row may be created for a token Redis does not know")
		}
	})
	// Repeated: the failure mode is an interleaving (two inserts of the same
	// legacy row racing on a non-arbiter unique index), so one round can pass by luck.
	t.Run("concurrent adoption of one legacy token", func(t *testing.T) {
		for round := 0; round < 80; round++ {
			userID, _ := g.newUser("cashier")
			j := fmt.Sprintf("00000000-0000-4000-8f09-%012d", round)
			mr.Set("refresh:"+j, userID)
			tok := g.legacyToken(userID, j, iat)
			const n = 20
			codes, jtis := make([]int, n), make([]string, n)
			g.parallel(n, func(i int) {
				p, code := g.refresh(srv, tok)
				codes[i] = code
				if code == 200 {
					jtis[i] = g.jti(p.Refresh)
				}
			})
			for i := range codes {
				if codes[i] != 200 || jtis[i] != jtis[0] {
					t.Fatalf("round %d goroutine %d: %d jti %s (want 200 and one shared jti %s)", round, i, codes[i], jtis[i], jtis[0])
				}
			}
			if rows := g.count(`SELECT count(*) FROM refresh_tokens WHERE family_id=$1`, j); rows != 2 {
				t.Fatalf("round %d: family has %d rows, want 2", round, rows)
			}
			if live := g.live(userID); live != 1 {
				t.Fatalf("round %d: %d live rows, want 1", round, live)
			}
		}
	})
}

// ---- case 7: expired / foreign / deleted ----------------------------------

func (g *auGate) expiredForeignDeleted(t *testing.T) {
	c, mr := g.miniCache(t)
	srv := g.router(c)

	userID, email := g.newUser("cashier")
	exp, err := auth.SignRefresh(g.cfg.RefreshSecret, userID, "00000000-0000-4000-8f05-000000000001",
		time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, code := g.refresh(srv, exp); code != 401 {
		t.Fatalf("expired jwt: %d want 401", code)
	}

	// A row that belongs to another user must not be exchangeable, adopted or
	// otherwise touched, even with a matching Redis key.
	owner, _ := g.newUser("cashier")
	const j = "00000000-0000-4000-8f05-000000000002"
	iat := time.Now().Truncate(time.Second)
	g.exec(`INSERT INTO refresh_tokens(jti,user_id,family_id,created_at,expires_at) VALUES($1,$2,$1,$3,$4)`,
		j, owner, iat, iat.Add(time.Hour))
	mr.Set("refresh:"+j, userID)
	before := g.rowJSON(j)
	if _, code := g.refresh(srv, g.legacyToken(userID, j, iat)); code != 401 {
		t.Fatalf("foreign row: %d want 401", code)
	}
	if g.rowJSON(j) != before {
		t.Fatal("a foreign row must be unchanged")
	}

	tok := g.mustLogin(srv, email)
	g.exec(`DELETE FROM users WHERE id=$1`, userID) // cascades the session rows
	if _, code := g.refresh(srv, tok.Refresh); code != 401 {
		t.Fatalf("deleted user: %d want 401", code)
	}
}

// ---- case 8: startup without Redis ----------------------------------------

func (g *auGate) startupWithoutRedis(t *testing.T) {
	for name, url := range map[string]string{"refused": "redis://127.0.0.1:1/0", "disabled": ""} {
		start := time.Now()
		c, err := cache.Connect(g.ctx, url, cache.Options{})
		if err != nil || c == nil {
			t.Fatalf("%s: Connect must not fail: %v", name, err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("%s: Connect took %v", name, time.Since(start))
		}
		// server.New serves (the full flows run in case 1 for each mode).
		if w := g.call(g.router(c), "GET", "/readyz", "", "", g.nextIP()); w.Code != 200 {
			t.Fatalf("%s: readyz %d", name, w.Code)
		}
	}
	// Blackholed: the ping is bounded by the op timeout.
	start := time.Now()
	g.blackholeCache(t)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("blackhole Connect took %v", time.Since(start))
	}
}

// ---- case 9: old-revision compatibility ------------------------------------

func (g *auGate) oldRevision(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, _ := g.newUser("cashier")

	// The previous revision's 3-column INSERT leaves family_id NULL.
	const j = "00000000-0000-4000-8f06-000000000001"
	iat := time.Now().Truncate(time.Second)
	g.exec(`INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)`, j, userID, iat.Add(time.Hour))
	g.exec(`UPDATE refresh_tokens SET created_at=$2 WHERE jti=$1`, j, iat)
	next, code := g.refresh(srv, g.legacyToken(userID, j, iat))
	if code != 200 {
		t.Fatalf("NULL-family row must refresh: %d", code)
	}
	var family string
	if err := g.pool.QueryRow(g.ctx, `SELECT family_id::text FROM refresh_tokens WHERE jti=$1`, g.jti(next.Refresh)).Scan(&family); err != nil || family != j {
		t.Fatalf("successor family %q (want root %s): %v", family, j, err)
	}

	// An old-style revoke (no replaced_by): a replay must be refused.
	const k = "00000000-0000-4000-8f06-000000000002"
	g.exec(`INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)`, k, userID, iat.Add(time.Hour))
	g.exec(`UPDATE refresh_tokens SET created_at=$2 WHERE jti=$1`, k, iat)
	g.exec(`UPDATE refresh_tokens SET revoked=true WHERE jti=$1`, k)
	if _, code := g.refresh(srv, g.legacyToken(userID, k, iat)); code != 401 {
		t.Fatalf("old-style revoke then replay: %d want 401", code)
	}
}

// ---- case 10: cleanup -------------------------------------------------------

func (g *auGate) cleanup(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	ins := func(jti, extra string) {
		g.exec(fmt.Sprintf(`INSERT INTO refresh_tokens(jti,user_id,family_id,created_at,expires_at,revoked) VALUES($1,$2,$1,now(),%s)`, extra), jti, userID)
	}
	const (
		old1    = "00000000-0000-4000-8f07-000000000001"
		old2    = "00000000-0000-4000-8f07-000000000002"
		recent  = "00000000-0000-4000-8f07-000000000003"
		liveJ   = "00000000-0000-4000-8f07-000000000004"
		revoked = "00000000-0000-4000-8f07-000000000005"
	)
	ins(old1, `now() - interval '3 days', false`)
	ins(old2, `now() - interval '2 days', true`)
	ins(recent, `now() - interval '1 hour', false`)
	ins(liveJ, `now() + interval '1 hour', false`)
	ins(revoked, `now() + interval '1 hour', true`)

	g.mustLogin(srv, email)
	if n := g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=ANY($1)`, []string{old1, old2}); n != 0 {
		t.Fatalf("login must delete this user's rows expired more than a day ago, %d left", n)
	}
	for _, j := range []string{recent, liveJ, revoked} {
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, j) != 1 {
			t.Fatalf("%s must be kept (recently expired, live, or revoked-but-unexpired)", j)
		}
	}

	// The startup sweep is bounded and has the same keep rules.
	other, _ := g.newUser("cashier")
	for i := 0; i < 3; i++ {
		g.exec(`INSERT INTO refresh_tokens(jti,user_id,created_at,expires_at) VALUES($1,$2,now(),now() - interval '5 days')`,
			fmt.Sprintf("00000000-0000-4000-8f08-%012d", i), other)
	}
	n, err := g.store.SweepExpiredRefresh(g.ctx, 2)
	if err != nil || n != 2 {
		t.Fatalf("sweep with limit 2 deleted %d (%v)", n, err)
	}
	n, err = g.store.SweepExpiredRefresh(g.ctx, 5000)
	if err != nil || n != 1 {
		t.Fatalf("second sweep deleted %d (%v), want the last 1", n, err)
	}
	for _, j := range []string{recent, liveJ, revoked} {
		if g.count(`SELECT count(*) FROM refresh_tokens WHERE jti=$1`, j) != 1 {
			t.Fatalf("sweep must keep %s", j)
		}
	}
}
