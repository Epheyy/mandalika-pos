package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func loginRec(h *Handler, remote, email string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"`+email+`","password":"x"}`))
	req.RemoteAddr = remote + ":1000"
	rec := httptest.NewRecorder()
	h.Login(rec, req)
	return rec
}

func TestLoginIPEmailLimit429SendsWindowSeconds(t *testing.T) {
	fb := newFake()
	fb.authErr = ErrNotFound
	h := sessionHandler(t, fb, disabledCache(t))
	for i := 0; i < 10; i++ {
		loginRec(h, "198.51.100.40", "a@b.c")
	}
	rec := loginRec(h, "198.51.100.40", "a@b.c")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d", rec.Code)
	}
	want := strconv.Itoa(int(loginRateWindow.Seconds()))
	if got := rec.Header().Get("Retry-After"); got != want || want != "300" {
		t.Fatalf("Retry-After %q want %q (5 min window)", got, want)
	}
}

func TestLoginEmailCap429SendsFailWindowSeconds(t *testing.T) {
	fb := newFake()
	fb.authErr = ErrNotFound
	h := sessionHandler(t, fb, disabledCache(t))
	for i := 0; i < loginEmailFailLimit; i++ {
		loginRec(h, "203.0.113."+strconv.Itoa(i+1), "victim@b.c")
	}
	rec := loginRec(h, "203.0.113.200", "victim@b.c")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d", rec.Code)
	}
	want := strconv.Itoa(int(loginEmailFailWindow.Seconds()))
	if got := rec.Header().Get("Retry-After"); got != want || want != "900" {
		t.Fatalf("Retry-After %q want %q (15 min window)", got, want)
	}
}

func TestRefreshUnavailable503SendsShortRetryAfter(t *testing.T) {
	fb := newFake()
	fb.rotateErr = errors.New("db down")
	h := sessionHandler(t, fb, disabledCache(t))
	rec := post(h.Refresh, `{"refresh":"`+validRefresh(t, h)+`"}`)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
}
