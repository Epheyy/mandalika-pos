package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
)

type fakeBackend struct {
	user     *User
	hash     string
	authErr  error
	issueErr error
	issued   []Session

	rotateRes *RotateResult
	rotateErr error
	gotRotate RotateInput

	revoked   []string
	revokeErr error
	gotRevoke RevokeInput
}

func (f *fakeBackend) Authenticate(context.Context, string, string) (*User, string, error) {
	return f.user, f.hash, f.authErr
}
func (f *fakeBackend) ByID(context.Context, string) (*User, error) { return f.user, nil }
func (f *fakeBackend) IssueSession(_ context.Context, _ *User, _ string, s Session) error {
	if f.issueErr != nil {
		return f.issueErr
	}
	f.issued = append(f.issued, s)
	return nil
}
func (f *fakeBackend) RotateSession(_ context.Context, in RotateInput) (*RotateResult, error) {
	f.gotRotate = in
	return f.rotateRes, f.rotateErr
}
func (f *fakeBackend) RevokeFamily(_ context.Context, in RevokeInput) ([]string, error) {
	f.gotRevoke = in
	return f.revoked, f.revokeErr
}

func newFake() *fakeBackend {
	return &fakeBackend{user: &User{ID: targetID, Role: "cashier", Permissions: []string{}}, hash: "h"}
}

func sessionHandler(t *testing.T, fb *fakeBackend, c *cache.Cache) *Handler {
	t.Helper()
	return &Handler{
		Cfg: &config.Config{
			AccessSecret: []byte(strings.Repeat("a", 48)), RefreshSecret: []byte(strings.Repeat("r", 48)),
			AccessTTL: 15 * time.Minute, RefreshTTL: time.Hour,
		},
		Cache: c, backend: fb,
	}
}

func miniCache(t *testing.T) (*cache.Cache, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	return cache.NewFromClient(rc), mr
}

func disabledCache(t *testing.T) *cache.Cache {
	t.Helper()
	c, _ := cache.Connect(context.Background(), "", cache.Options{})
	return c
}

func post(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/auth/x", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func validRefresh(t *testing.T, h *Handler) string {
	t.Helper()
	return signRefresh(t, h, "old-jti", time.Now().Truncate(time.Second))
}

func TestLoginInsertFailureIssuesNoTokens(t *testing.T) {
	fb := newFake()
	fb.issueErr = errors.New("insert failed")
	h := sessionHandler(t, fb, disabledCache(t))
	rec := post(h.Login, `{"email":"a@b.c","password":"x"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "access") || strings.Contains(rec.Body.String(), "refresh") {
		t.Fatalf("tokens leaked on a failed insert: %s", rec.Body)
	}
}

func TestLoginMapping(t *testing.T) {
	for name, c := range map[string]struct {
		mutate func(*fakeBackend)
		want   int
	}{
		"ok":                  {func(*fakeBackend) {}, 200},
		"bad credentials":     {func(f *fakeBackend) { f.authErr = ErrNotFound }, 401},
		"lookup db error":     {func(f *fakeBackend) { f.authErr = errors.New("db") }, 500},
		"credentials changed": {func(f *fakeBackend) { f.issueErr = ErrCredentialsChanged }, 401},
		"user vanished":       {func(f *fakeBackend) { f.issueErr = ErrNotFound }, 401},
	} {
		t.Run(name, func(t *testing.T) {
			fb := newFake()
			c.mutate(fb)
			h := sessionHandler(t, fb, disabledCache(t))
			if rec := post(h.Login, `{"email":"a@b.c","password":"x"}`); rec.Code != c.want {
				t.Fatalf("status %d want %d body=%s", rec.Code, c.want, rec.Body)
			}
		})
	}
}

func loginFrom(h *Handler, remote, email string) int {
	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"`+email+`","password":"x"}`))
	req.RemoteAddr = remote + ":1000"
	rec := httptest.NewRecorder()
	h.Login(rec, req)
	return rec.Code
}

// With Redis disabled the login limits are still enforced, from memory.
func TestLoginLimitsEnforcedFromMemoryWithoutRedis(t *testing.T) {
	t.Run("ip+email limit", func(t *testing.T) {
		fb := newFake()
		fb.authErr = ErrNotFound
		h := sessionHandler(t, fb, disabledCache(t))
		for i := 1; i <= 10; i++ {
			if code := loginFrom(h, "198.51.100.1", "a@b.c"); code != 401 {
				t.Fatalf("attempt %d: %d want 401", i, code)
			}
		}
		if code := loginFrom(h, "198.51.100.1", "a@b.c"); code != 429 {
			t.Fatalf("attempt 11: %d want 429", code)
		}
		if code := loginFrom(h, "198.51.100.2", "a@b.c"); code != 401 {
			t.Fatalf("a different IP has its own ip+email bucket: %d", code)
		}
	})
	t.Run("per-email failure cap across IPs", func(t *testing.T) {
		fb := newFake()
		fb.authErr = ErrNotFound
		h := sessionHandler(t, fb, disabledCache(t))
		for i := 0; i < loginEmailFailLimit; i++ {
			if code := loginFrom(h, fmt.Sprintf("203.0.113.%d", i+1), "victim@b.c"); code != 401 {
				t.Fatalf("failure %d: %d want 401", i, code)
			}
		}
		if code := loginFrom(h, "203.0.113.200", "victim@b.c"); code != 429 {
			t.Fatalf("after %d failures the email must be capped: %d want 429", loginEmailFailLimit, code)
		}
		if code := loginFrom(h, "203.0.113.201", "other@b.c"); code != 401 {
			t.Fatalf("another email is unaffected: %d", code)
		}
	})
}

// A failed Redis mirror write must leave a log line the rollback runbook can grep.
func TestMirrorFailureIsLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	c, mr := miniCache(t)
	mr.Close() // transport errors, not a disabled cache
	h := sessionHandler(t, newFake(), c)
	if rec := post(h.Login, `{"email":"a@b.c","password":"x"}`); rec.Code != 200 {
		t.Fatalf("login must still succeed: %d", rec.Code)
	}
	if !strings.Contains(buf.String(), "refresh_mirror_failed") {
		t.Fatalf("expected refresh_mirror_failed, got %q", buf.String())
	}
	if strings.Contains(buf.String(), "access") && strings.Contains(buf.String(), "eyJ") {
		t.Fatal("no token values in logs")
	}
}

// The limiter keys (Redis and memory) must never carry the raw email.
func TestLoginKeysNeverContainRawEmail(t *testing.T) {
	const raw = "Victim.Name@Example.COM"
	for _, k := range []string{loginRateKey("203.0.113.9", raw), loginEmailKey(raw)} {
		if strings.Contains(strings.ToLower(k), "victim") || strings.Contains(k, "@") {
			t.Fatalf("key leaks the email: %q", k)
		}
	}
	if loginEmailKey(raw) != loginEmailKey("  victim.name@example.com ") {
		t.Fatal("keys must be built from the normalized email")
	}
	if loginEmailKey("a@b.c") == loginEmailKey("a@b.d") {
		t.Fatal("distinct emails must get distinct keys")
	}
	if len(loginEmailKey(raw)) > len("rl:login:email:")+64 {
		t.Fatalf("key not bounded: %d", len(loginEmailKey(raw)))
	}
}

// Body caps: login 8 KiB (413), refresh and logout 16 KiB (400, never 413: the
// client treats any non-5xx/429 non-OK refresh status as "rejected").
func TestBodyCaps(t *testing.T) {
	fb := newFake()
	fb.rotateErr = ErrRefreshRejected
	h := sessionHandler(t, fb, disabledCache(t))
	big := strings.Repeat("a", 20<<10)

	if rec := post(h.Login, `{"email":"`+big+`","password":"x"}`); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized login: %d want 413", rec.Code)
	}
	if rec := post(h.Login, `{"email":"a@b.c","password":"x"}`); rec.Code != 200 {
		t.Fatalf("normal login: %d", rec.Code)
	}
	// 8 KiB boundary: just over the login cap, still fine for refresh/logout.
	over := strings.Repeat("b", 9<<10)
	if rec := post(h.Login, `{"email":"`+over+`","password":"x"}`); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("9 KiB login: %d want 413", rec.Code)
	}

	tok := validRefresh(t, h) // a few hundred bytes, like the real client
	if rec := post(h.Refresh, `{"refresh":"`+tok+`"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("normal refresh must reach the store (rejected->401): %d", rec.Code)
	}
	if rec := post(h.Refresh, `{"refresh":"`+over+`"}`); rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatal("refresh must never answer 413")
	}
	if rec := post(h.Refresh, `{"refresh":"`+big+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized refresh: %d want 400", rec.Code)
	}
	if rec := post(h.Logout, `{"refresh":"`+tok+`"}`); rec.Code != 200 {
		t.Fatalf("normal logout: %d", rec.Code)
	}
	if rec := post(h.Logout, `{"refresh":"`+big+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized logout: %d want 400", rec.Code)
	}
}

// Logout hands the legacy-adoption verdict to the store (tombstone for a rowless
// token whose Redis key is valid).
func TestLogoutPassesClaimsAndLegacyVerdict(t *testing.T) {
	fb := newFake()
	h := sessionHandler(t, fb, disabledCache(t))
	tok := validRefresh(t, h)
	if rec := post(h.Logout, `{"refresh":"`+tok+`"}`); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if fb.gotRevoke.Claims == nil || fb.gotRevoke.Claims.ID != "old-jti" || fb.gotRevoke.Legacy == nil {
		t.Fatalf("store did not receive claims and the legacy verdict: %+v", fb.gotRevoke)
	}
}

// The refresh status contract: the client logs out on any non-OK status that is
// not 429 or >=500, so refresh may only answer 200, 400 (bad body), 401, 429, 5xx.
func TestRefreshStatusContract(t *testing.T) {
	soon := time.Now().Add(time.Hour).Truncate(time.Second)
	okRes := func() *RotateResult {
		return &RotateResult{User: &User{ID: targetID, Role: "cashier"},
			Session: Session{JTI: "new-jti", IssuedAt: time.Now().Truncate(time.Second), ExpiresAt: soon}}
	}
	cases := []struct {
		name string
		res  *RotateResult
		err  error
		want int
	}{
		{"success", okRes(), nil, 200},
		{"rejected", nil, ErrRefreshRejected, 401},
		{"wrapped rejected", nil, fmt.Errorf("x: %w", ErrRefreshRejected), 401},
		{"user not found", nil, ErrNotFound, 401},
		{"db error", nil, errors.New("connection reset"), 503},
		{"permissions query error", nil, fmt.Errorf("perm: %w", errors.New("boom")), 503},
		{"adoption verdict unavailable", nil, ErrAdoptionUnavailable, 503},
		{"context deadline", nil, context.DeadlineExceeded, 503},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fb := newFake()
			fb.rotateRes, fb.rotateErr = c.res, c.err
			h := sessionHandler(t, fb, disabledCache(t)) // Redis disabled: refresh works via PG alone
			rec := post(h.Refresh, `{"refresh":"`+validRefresh(t, h)+`"}`)
			assertContract(t, rec.Code)
			if rec.Code != c.want {
				t.Fatalf("status %d want %d body=%s", rec.Code, c.want, rec.Body)
			}
		})
	}
	h := sessionHandler(t, newFake(), disabledCache(t))
	for name, body := range map[string]string{
		"garbage jwt":     `{"refresh":"not.a.jwt"}`,
		"empty token":     `{"refresh":""}`,
		"wrong secret":    `{"refresh":"` + signWith(t, "another-secret-another-secret-another-secret!!") + `"}`,
		"expired token":   `{"refresh":"` + signExpired(t, h) + `"}`,
		"missing field":   `{}`,
		"extra field":     `{"refresh":"x","y":1}`,
		"not json":        `{`,
		"wrong json type": `{"refresh":5}`,
	} {
		rec := post(h.Refresh, body)
		assertContract(t, rec.Code)
		if name == "not json" || name == "extra field" || name == "wrong json type" {
			if rec.Code != 400 {
				t.Errorf("%s: status %d want 400", name, rec.Code)
			}
			continue
		}
		if rec.Code != 401 {
			t.Errorf("%s: status %d want 401", name, rec.Code)
		}
	}
}

func assertContract(t *testing.T, code int) {
	t.Helper()
	switch {
	case code == 200, code == 400, code == 401, code == 429, code >= 500:
	default:
		t.Fatalf("refresh answered %d: outside the 200/400/401/429/5xx contract (client would log out)", code)
	}
}

func signWith(t *testing.T, secret string) string {
	t.Helper()
	tok, err := SignRefresh([]byte(secret), targetID, "j", time.Now(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func signExpired(t *testing.T, h *Handler) string {
	t.Helper()
	tok, err := SignRefresh(h.Cfg.RefreshSecret, targetID, "j", time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestRefreshMirrorsToRedisWithRemainingTTL(t *testing.T) {
	c, mr := miniCache(t)
	fb := newFake()
	exp := time.Now().Add(40 * time.Minute).Truncate(time.Second)
	fb.rotateRes = &RotateResult{User: fb.user, Session: Session{JTI: "new-jti", IssuedAt: time.Now().Truncate(time.Second), ExpiresAt: exp}}
	h := sessionHandler(t, fb, c)
	mr.Set("refresh:old-jti", targetID)
	rec := post(h.Refresh, `{"refresh":"`+validRefresh(t, h)+`"}`)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if v, err := mr.Get("refresh:new-jti"); err != nil || v != targetID {
		t.Fatalf("new key missing: %v %q", err, v)
	}
	if mr.Exists("refresh:old-jti") {
		t.Fatal("old key must be deleted")
	}
	if ttl := mr.TTL("refresh:new-jti"); ttl <= 0 || ttl > 40*time.Minute {
		t.Fatalf("ttl %v must be the token's remaining life, not the full RefreshTTL", ttl)
	}
}

// Re-minting the same session twice yields the byte-identical refresh token.
func TestRemintIsDeterministic(t *testing.T) {
	fb := newFake()
	iat := time.Now().Truncate(time.Second)
	fb.rotateRes = &RotateResult{User: fb.user, Remint: true,
		Session: Session{JTI: "y-jti", IssuedAt: iat, ExpiresAt: iat.Add(time.Hour)}}
	h := sessionHandler(t, fb, disabledCache(t))
	var tokens [2]string
	for i := range tokens {
		rec := post(h.Refresh, `{"refresh":"`+validRefresh(t, h)+`"}`)
		var env struct {
			Data struct {
				Refresh string `json:"refresh"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.Data.Refresh == "" {
			t.Fatalf("body %s err %v", rec.Body, err)
		}
		tokens[i] = env.Data.Refresh
	}
	if tokens[0] != tokens[1] {
		t.Fatal("re-mint must return the identical token")
	}
	rc, err := ParseRefresh(h.Cfg.RefreshSecret, tokens[0])
	if err != nil || rc.ID != "y-jti" || rc.IssuedAt.Unix() != iat.Unix() {
		t.Fatalf("claims %+v err %v", rc, err)
	}
}

func TestLogoutRevokesFamilyAndAlwaysSucceeds(t *testing.T) {
	c, mr := miniCache(t)
	fb := newFake()
	fb.revoked = []string{"a", "b"}
	h := sessionHandler(t, fb, c)
	for _, k := range []string{"old-jti", "a", "b", "other"} {
		mr.Set("refresh:"+k, targetID)
	}
	if rec := post(h.Logout, `{"refresh":"`+validRefresh(t, h)+`"}`); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	for _, k := range []string{"old-jti", "a", "b"} {
		if mr.Exists("refresh:" + k) {
			t.Fatalf("refresh:%s must be deleted", k)
		}
	}
	if !mr.Exists("refresh:other") {
		t.Fatal("unrelated key must survive")
	}
	fb.revokeErr = errors.New("db down")
	if rec := post(h.Logout, `{"refresh":"`+validRefresh(t, h)+`"}`); rec.Code != 200 {
		t.Fatalf("logout must answer 200 even on a DB error, got %d", rec.Code)
	}
}

// Adoption (D4): a rowless legacy token is judged from Redis only.
func TestAdoptLegacy(t *testing.T) {
	iat := time.Now().Add(-time.Hour).Truncate(time.Second)
	claims := func() *RefreshClaims {
		return &RefreshClaims{UserID: targetID, RegisteredClaims: jwt.RegisteredClaims{
			ID: "legacy", IssuedAt: jwt.NewNumericDate(iat)}}
	}
	ctx := context.Background()

	t.Run("live key adopts", func(t *testing.T) {
		c, mr := miniCache(t)
		mr.Set("refresh:legacy", targetID)
		ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims())
		if !ok || err != nil {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("no key is a definitive no", func(t *testing.T) {
		c, _ := miniCache(t)
		ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims())
		if ok || err != nil {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("key for another user", func(t *testing.T) {
		c, mr := miniCache(t)
		mr.Set("refresh:legacy", "someone-else")
		if ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims()); ok || err != nil {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("reset marker newer than iat", func(t *testing.T) {
		c, mr := miniCache(t)
		mr.Set("refresh:legacy", targetID)
		mr.Set(refreshRevokedKey(targetID), fmt.Sprint(iat.Unix()+5))
		if ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims()); ok || err != nil {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("marker unreadable is no verdict", func(t *testing.T) {
		c, mr := miniCache(t)
		mr.Set("refresh:legacy", targetID)
		mr.HSet(refreshRevokedKey(targetID), "f", "v") // WRONGTYPE
		if ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims()); ok || !errors.Is(err, ErrAdoptionUnavailable) {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("redis closed", func(t *testing.T) {
		c, mr := miniCache(t)
		mr.Close()
		if ok, err := sessionHandler(t, newFake(), c).adoptLegacy(ctx, claims()); ok || !errors.Is(err, ErrAdoptionUnavailable) {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
	t.Run("redis disabled", func(t *testing.T) {
		if ok, err := sessionHandler(t, newFake(), disabledCache(t)).adoptLegacy(ctx, claims()); ok || !errors.Is(err, ErrAdoptionUnavailable) {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
	})
}
