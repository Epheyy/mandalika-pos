package auth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
)

const (
	actorID  = "11111111-1111-1111-1111-111111111111"
	targetID = "22222222-2222-2222-2222-222222222222"
	goodPW   = "S3cret-new-pass"
)

type fakeResetStore struct {
	resetErr  error
	jtis      []string
	gotHash   string
	resetHits int
}

func (f *fakeResetStore) ResetPassword(_ context.Context, _ string, hash string) (ResetResult, error) {
	f.resetHits++
	f.gotHash = hash
	if f.resetErr != nil {
		return ResetResult{}, f.resetErr
	}
	return ResetResult{Email: "Cashier@Outlet.ID", Role: "cashier"}, nil
}

func (f *fakeResetStore) ActiveRefreshJTIs(context.Context, string) ([]string, error) {
	return f.jtis, nil
}

func newResetHarness(t *testing.T, st *fakeResetStore) (*Handler, *miniredis.Miniredis, http.Handler) {
	t.Helper()
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rc.Close() })
	h := &Handler{
		Cfg:   &config.Config{RefreshSecret: []byte(strings.Repeat("r", 48)), RefreshTTL: time.Hour},
		Cache: &cache.Cache{R: rc},
		reset: st,
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), CtxUserID, actorID)))
		})
	})
	r.Post("/users/{id}/reset-password", h.AdminResetPassword)
	return h, mr, r
}

func doReset(router http.Handler, id, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/users/"+id+"/reset-password", strings.NewReader(body))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func pwBody(pw string) string { return `{"password":"` + pw + `"}` }

func TestRefreshRevoked(t *testing.T) {
	at := func(sec int64) *jwt.NumericDate { return jwt.NewNumericDate(time.Unix(sec, 0)) }
	cases := []struct {
		name      string
		iat       *jwt.NumericDate
		marker    string
		hasMarker bool
		want      bool
	}{
		{"no marker", at(100), "", false, false},
		{"iat before marker", at(100), "101", true, true},
		{"iat equals marker", at(101), "101", true, false},
		{"iat after marker", at(200), "101", true, false},
		{"garbage marker fails closed", at(200), "nope", true, true},
		{"missing iat fails closed", nil, "101", true, true},
	}
	for _, c := range cases {
		if got := refreshRevoked(c.iat, c.marker, c.hasMarker); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestAdminResetPasswordRejections(t *testing.T) {
	cases := []struct {
		name, id, body string
		store          *fakeResetStore
		want           int
		wantHits       int
	}{
		{"weak password", targetID, pwBody("short"), &fakeResetStore{}, 400, 0},
		{"too long", targetID, pwBody(strings.Repeat("a", 129)), &fakeResetStore{}, 400, 0},
		{"bad json", targetID, `{`, &fakeResetStore{}, 400, 0},
		{"unknown field", targetID, `{"password":"` + goodPW + `","x":1}`, &fakeResetStore{}, 400, 0},
		{"bad uuid", "not-a-uuid", pwBody(goodPW), &fakeResetStore{}, 400, 0},
		{"self", actorID, pwBody(goodPW), &fakeResetStore{}, 403, 0},
		{"unknown user", targetID, pwBody(goodPW), &fakeResetStore{resetErr: ErrNotFound}, 404, 1},
		{"db failure", targetID, pwBody(goodPW), &fakeResetStore{resetErr: errors.New("boom secret detail")}, 500, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, router := newResetHarness(t, c.store)
			rec := doReset(router, c.id, c.body)
			if rec.Code != c.want {
				t.Fatalf("status %d want %d body=%s", rec.Code, c.want, rec.Body)
			}
			if c.store.resetHits != c.wantHits {
				t.Fatalf("store hits %d want %d", c.store.resetHits, c.wantHits)
			}
			if strings.Contains(rec.Body.String(), "boom") {
				t.Fatalf("raw error leaked: %s", rec.Body)
			}
		})
	}
}

func TestAdminResetPasswordMarkerFailureChangesNothing(t *testing.T) {
	st := &fakeResetStore{}
	_, mr, router := newResetHarness(t, st)
	mr.Close() // Redis unreachable: marker cannot be set
	rec := doReset(router, targetID, pwBody(goodPW))
	if rec.Code != 500 {
		t.Fatalf("status %d want 500", rec.Code)
	}
	if st.resetHits != 0 {
		t.Fatal("DB must not be touched when the marker cannot be set")
	}
}

func TestAdminResetPasswordSuccessEffects(t *testing.T) {
	jtis := make([]string, 250) // exercises batching
	for i := range jtis {
		jtis[i] = fmt.Sprintf("jti-%04d", i)
	}
	st := &fakeResetStore{jtis: jtis}
	h, mr, router := newResetHarness(t, st)
	for _, j := range jtis {
		mr.Set("refresh:"+j, targetID)
	}
	mr.Set("refresh:unrelated", "other-user")
	mr.Set(loginEmailKey("cashier@outlet.id"), "30")
	mr.Set("rl:login:203.0.113.5:cashier@outlet.id", "3")
	h.now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	rec := doReset(router, targetID, pwBody(goodPW))
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("status %d body %q", rec.Code, rec.Body)
	}
	if ok, err := VerifyPassword(goodPW, st.gotHash); err != nil || !ok {
		t.Fatalf("stored hash does not verify: ok=%v err=%v", ok, err)
	}
	if got, _ := mr.Get(refreshRevokedKey(targetID)); got != "1700000001" {
		t.Fatalf("marker = %q", got)
	}
	if ttl := mr.TTL(refreshRevokedKey(targetID)); ttl != time.Hour {
		t.Fatalf("marker ttl = %v", ttl)
	}
	for _, j := range jtis {
		if mr.Exists("refresh:" + j) {
			t.Fatalf("refresh:%s still present", j)
		}
	}
	if !mr.Exists("refresh:unrelated") {
		t.Fatal("other user's session must survive")
	}
	if mr.Exists(loginEmailKey("cashier@outlet.id")) {
		t.Fatal("per-account lockout not cleared")
	}
	if !mr.Exists("rl:login:203.0.113.5:cashier@outlet.id") {
		t.Fatal("per-IP bucket must NOT be cleared")
	}
}

func TestRefreshUsableAroundReset(t *testing.T) {
	h, mr, router := newResetHarness(t, &fakeResetStore{})
	secret := h.Cfg.RefreshSecret
	resetAt := time.Now().Add(-10 * time.Second).Truncate(time.Second)
	h.now = func() time.Time { return resetAt }

	n := 0
	mk := func(iat time.Time) *RefreshClaims {
		n++
		jti := fmt.Sprintf("jti-%d", n)
		c := RefreshClaims{UserID: targetID, RegisteredClaims: jwt.RegisteredClaims{
			ID: jti, IssuedAt: jwt.NewNumericDate(iat), ExpiresAt: jwt.NewNumericDate(iat.Add(time.Hour))}}
		tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(secret)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseRefresh(secret, tok)
		if err != nil {
			t.Fatal(err)
		}
		mr.Set("refresh:"+jti, targetID)
		return parsed
	}
	ctx := context.Background()
	if !h.refreshUsable(ctx, mk(resetAt.Add(-5*time.Minute))) {
		t.Fatal("token must be usable before any reset")
	}
	if rec := doReset(router, targetID, pwBody(goodPW)); rec.Code != 204 {
		t.Fatalf("reset status %d", rec.Code)
	}
	// Even with its Redis key present, a pre-reset token is rejected by the marker.
	if h.refreshUsable(ctx, mk(resetAt.Add(-5*time.Minute))) {
		t.Fatal("pre-reset refresh token must be rejected")
	}
	if !h.refreshUsable(ctx, mk(time.Now().Truncate(time.Second))) {
		t.Fatal("token issued after reset must stay usable")
	}
}

func TestAdminResetPasswordLogsNoSecrets(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	for _, st := range []*fakeResetStore{{}, {resetErr: errors.New("db down")}} {
		_, _, router := newResetHarness(t, st)
		doReset(router, targetID, pwBody(goodPW))
	}
	out := buf.String()
	if !strings.Contains(out, "admin_password_reset") {
		t.Fatalf("expected audit line, got %q", out)
	}
	if strings.Contains(out, goodPW) || strings.Contains(out, "$argon2id$") {
		t.Fatalf("password or hash leaked into logs: %s", out)
	}
}
