package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
)

// Subtests 11-20 of TestAuthAuthorityPostgres: instant permission revocation
// (users.perm_version, the "pv" claim, RequireAuth) and the open-shift guards,
// driven over HTTP against the full router and a real PostgreSQL.

const auOutletB = "00000000-0000-4000-8f00-000000000002"

const (
	msgShiftDelete = "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus."
	msgShiftMove   = "Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet."
)

type recPublisher struct {
	mu      sync.Mutex
	pubs    []int64
	deleted []string
}

func (r *recPublisher) Publish(_ context.Context, _ string, v int64) {
	r.mu.Lock()
	r.pubs = append(r.pubs, v)
	r.mu.Unlock()
}

func (r *recPublisher) PublishDeleted(_ context.Context, uid string) {
	r.mu.Lock()
	r.deleted = append(r.deleted, uid)
	r.mu.Unlock()
}

func (r *recPublisher) snapshot() ([]int64, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int64(nil), r.pubs...), append([]string(nil), r.deleted...)
}

// callH is call with extra request headers.
func (g *auGate) callH(srv http.Handler, method, path, body, bearer string, hdr map[string]string) *httptest.ResponseRecorder {
	g.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.1:4321"
	r.Header.Set("X-Forwarded-For", g.nextIP())
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	start := time.Now()
	srv.ServeHTTP(w, r)
	if d := time.Since(start); d > 2*time.Second {
		g.t.Errorf("%s %s took %v (> 2s)", method, path, d)
	}
	return w
}

func errOf(w *httptest.ResponseRecorder) string {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &e)
	return e.Error
}

func (g *auGate) wantStatus(t *testing.T, what string, w *httptest.ResponseRecorder, code int) {
	t.Helper()
	if w.Code != code {
		t.Fatalf("%s: status %d want %d body=%s", what, w.Code, code, w.Body)
	}
}

func (g *auGate) wantRevoked(t *testing.T, what string, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != 401 || errOf(w) != "token revoked" {
		t.Fatalf("%s: status %d err %q, want 401 token revoked (body=%s)", what, w.Code, errOf(w), w.Body)
	}
}

func (g *auGate) putUser(srv http.Handler, adminTok, id string, body map[string]any) *httptest.ResponseRecorder {
	g.t.Helper()
	raw, _ := json.Marshal(body)
	return g.callH(srv, "PUT", "/api/v1/users/"+id, string(raw), adminTok, nil)
}

func (g *auGate) grant(userID string, perms ...string) {
	g.t.Helper()
	for _, p := range perms {
		g.exec(`INSERT INTO user_permissions(user_id,permission) VALUES($1,$2)`, userID, p)
	}
}

func (g *auGate) permVersion(userID string) int64 {
	g.t.Helper()
	var v int64
	if err := g.pool.QueryRow(g.ctx, `SELECT perm_version FROM users WHERE id=$1`, userID).Scan(&v); err != nil {
		g.t.Fatal(err)
	}
	return v
}

func (g *auGate) claims(t *testing.T, access string) *auth.Claims {
	t.Helper()
	c, err := auth.ParseAccess(g.cfg.AccessSecret, access)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (g *auGate) ensureOutletB() {
	g.t.Helper()
	g.exec(`INSERT INTO outlets(id,name) VALUES($1,'AU outlet B') ON CONFLICT DO NOTHING`, auOutletB)
}

func (g *auGate) openShift(userID string) {
	g.t.Helper()
	g.exec(`INSERT INTO shifts(outlet_id,cashier_id,cashier_name,status,opened_at,business_date)
	        VALUES($1,$2,'AU user','open',now(),current_date)`, auOutlet, userID)
}

func (g *auGate) closeShifts(userID string) {
	g.t.Helper()
	g.exec(`UPDATE shifts SET status='closed', closed_at=now() WHERE cashier_id=$1`, userID)
}

// ---- 11: revoked permissions -------------------------------------------------

func (g *auGate) revokePerms(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	g.grant(userID, "view_reports")
	_, adminTok := g.adminToken(srv)

	a1 := g.mustLogin(srv, email)
	g.wantStatus(t, "reports with the permission", g.call(srv, "GET", "/api/v1/reports/summary", "", a1.Access, g.nextIP()), 200)

	g.wantStatus(t, "revoke", g.putUser(srv, adminTok, userID, map[string]any{"permissions": []string{}}), 200)
	g.wantRevoked(t, "old token after the permission was removed", g.call(srv, "GET", "/api/v1/reports/summary", "", a1.Access, g.nextIP()))

	a2, code := g.refresh(srv, a1.Refresh)
	if code != 200 {
		t.Fatalf("refresh after revoke: %d", code)
	}
	w := g.call(srv, "GET", "/api/v1/reports/summary", "", a2.Access, g.nextIP())
	if w.Code != 403 || errOf(w) != "missing permission: view_reports" {
		t.Fatalf("retry: %d %q, want 403 missing permission", w.Code, errOf(w))
	}
	g.wantStatus(t, "an unrelated route", g.call(srv, "GET", "/api/v1/products", "", a2.Access, g.nextIP()), 200)

	// Store level: only a real change bumps, and exactly one publish per bump.
	rec := &recPublisher{}
	st := auth.NewStore(g.pool)
	st.Versions = rec
	name, role := "Renamed", "cashier"
	before := g.permVersion(userID)
	if err := st.UpdateUser(g.ctx, userID, &name, &role, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if g.permVersion(userID) != before {
		t.Fatal("a name-only edit with an unchanged role must not bump")
	}
	if p, _ := rec.snapshot(); len(p) != 0 {
		t.Fatalf("no publish expected, got %v", p)
	}
	perms := []string{"view_reports"}
	if err := st.UpdateUser(g.ctx, userID, nil, nil, nil, nil, &perms); err != nil {
		t.Fatal(err)
	}
	if got := g.permVersion(userID); got != before+1 {
		t.Fatalf("permission change: version %d want %d", got, before+1)
	}
	if p, _ := rec.snapshot(); len(p) != 1 || p[0] != before+1 {
		t.Fatalf("publishes = %v, want exactly [%d]", p, before+1)
	}
	same := []string{"view_reports"}
	if err := st.UpdateUser(g.ctx, userID, nil, nil, nil, nil, &same); err != nil {
		t.Fatal(err)
	}
	if g.permVersion(userID) != before+1 {
		t.Fatal("an identical permission set must not bump")
	}
}

// ---- 12: revoked role and outlet --------------------------------------------

func (g *auGate) revokeRoleOutlet(t *testing.T) {
	g.ensureOutletB()
	c, _ := g.miniCache(t)
	srv := g.router(c)
	_, adminTok := g.adminToken(srv)

	userID, email := g.newUser("cashier")
	a1 := g.mustLogin(srv, email)
	oldOutlet := map[string]string{"X-Outlet-Id": auOutlet}
	g.wantStatus(t, "before the move", g.callH(srv, "GET", "/api/v1/products", "", a1.Access, oldOutlet), 200)
	g.wantStatus(t, "move", g.putUser(srv, adminTok, userID, map[string]any{"outletId": auOutletB}), 200)
	g.wantRevoked(t, "old token with the old outlet (a 403 would never refresh)",
		g.callH(srv, "GET", "/api/v1/products", "", a1.Access, oldOutlet))
	a2, code := g.refresh(srv, a1.Refresh)
	if code != 200 {
		t.Fatalf("refresh: %d", code)
	}
	g.wantStatus(t, "new token at the new outlet",
		g.callH(srv, "GET", "/api/v1/products", "", a2.Access, map[string]string{"X-Outlet-Id": auOutletB}), 200)

	promoted, pemail := g.newUser("cashier")
	p1 := g.mustLogin(srv, pemail)
	g.wantStatus(t, "promote", g.putUser(srv, adminTok, promoted, map[string]any{"role": "manager"}), 200)
	g.wantRevoked(t, "old cashier token after the promotion", g.call(srv, "GET", "/api/v1/products", "", p1.Access, g.nextIP()))
	p2, code := g.refresh(srv, p1.Refresh)
	if code != 200 {
		t.Fatalf("refresh: %d", code)
	}
	if got := g.claims(t, p2.Access).Role; got != "manager" {
		t.Fatalf("refreshed role %q, want manager", got)
	}
}

// ---- 13: revoked by delete ---------------------------------------------------

func (g *auGate) revokeDelete(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	srv2 := g.router(c) // a second instance sharing Redis
	_, adminTok := g.adminToken(srv)
	userID, email := g.newUser("cashier")
	a1 := g.mustLogin(srv, email)
	g.wantStatus(t, "before delete", g.call(srv, "GET", "/api/v1/products", "", a1.Access, g.nextIP()), 200)

	g.wantStatus(t, "delete", g.callH(srv, "DELETE", "/api/v1/users/"+userID, "", adminTok, nil), 204)
	g.wantRevoked(t, "deleted user's access token", g.call(srv, "GET", "/api/v1/products", "", a1.Access, g.nextIP()))
	g.wantRevoked(t, "deleted user's token on a second instance", g.call(srv2, "GET", "/api/v1/products", "", a1.Access, g.nextIP()))

	body, _ := json.Marshal(map[string]string{"refresh": a1.Refresh})
	w := g.call(srv, "POST", "/api/v1/auth/refresh", string(body), "", g.nextIP())
	if w.Code != 401 || errOf(w) != "user not found" {
		t.Fatalf("refresh of a deleted user: %d %q, want 401 user not found", w.Code, errOf(w))
	}
}

// ---- 14: revoked by password reset ------------------------------------------

func (g *auGate) revokeReset(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	_, adminTok := g.adminToken(srv)
	userID, email := g.newUser("cashier")
	a1 := g.mustLogin(srv, email)
	g.wantStatus(t, "before reset", g.call(srv, "GET", "/api/v1/products", "", a1.Access, g.nextIP()), 200)

	const newPW = "N3w-au-pass-reset-1"
	if code := g.resetPassword(srv, adminTok, userID, newPW); code != 200 && code != 204 {
		t.Fatalf("reset: %d", code)
	}
	g.wantRevoked(t, "old access token after the reset", g.call(srv, "GET", "/api/v1/products", "", a1.Access, g.nextIP()))
	if _, code := g.refresh(srv, a1.Refresh); code != 401 {
		t.Fatalf("old refresh after reset: %d want 401", code)
	}
	p, code := g.login(srv, email, newPW)
	if code != 200 {
		t.Fatalf("login with the new password: %d", code)
	}
	g.wantStatus(t, "the new token", g.call(srv, "GET", "/api/v1/products", "", p.Access, g.nextIP()), 200)
}

// ---- 15: revocation with Redis down -----------------------------------------

func (g *auGate) revokeRedisDown(t *testing.T) {
	g.ensureOutletB()
	for mode, build := range map[string]func() http.Handler{
		"refused":   func() http.Handler { return g.router(g.refusedCache(t)) },
		"disabled":  func() http.Handler { return g.router(g.disabledCache(t)) },
		"blackhole": func() http.Handler { return g.router(g.blackholeCache(t)) },
	} {
		srv := build()
		userID, email := g.newUser("cashier")
		other, otherEmail := g.newUser("cashier")
		_ = other
		a1 := g.mustLogin(srv, email)
		o1 := g.mustLogin(srv, otherEmail)

		// Revoke through the store only: this router's memo is not told, as if another instance wrote.
		st := auth.NewStore(g.pool)
		perms := []string{"view_reports"}
		if err := st.UpdateUser(g.ctx, userID, nil, nil, nil, nil, &perms); err != nil {
			t.Fatal(err)
		}
		g.wantRevoked(t, mode+": old token", g.call(srv, "GET", "/api/v1/products", "", a1.Access, g.nextIP()))
		a2, code := g.refresh(srv, a1.Refresh)
		if code != 200 {
			t.Fatalf("[%s] refresh: %d", mode, code)
		}
		g.wantStatus(t, mode+": retry with the fresh token", g.call(srv, "GET", "/api/v1/products", "", a2.Access, g.nextIP()), 200)
		g.wantStatus(t, mode+": an unrelated valid token", g.call(srv, "GET", "/api/v1/products", "", o1.Access, g.nextIP()), 200)
	}
}

// ---- 16: a second instance --------------------------------------------------

func (g *auGate) revokeSecondInstance(t *testing.T) {
	c, _ := g.miniCache(t)
	r1, r2 := g.router(c), g.router(c)
	_, adminTok := g.adminToken(r1)
	userID, email := g.newUser("cashier")
	a1 := g.mustLogin(r1, email)
	g.wantStatus(t, "warm R2", g.call(r2, "GET", "/api/v1/products", "", a1.Access, g.nextIP()), 200)

	perms := []string{"view_reports"}
	g.wantStatus(t, "revoke through R1", g.putUser(r1, adminTok, userID, map[string]any{"permissions": perms}), 200)
	g.wantRevoked(t, "R1 refuses at once", g.call(r1, "GET", "/api/v1/products", "", a1.Access, g.nextIP()))

	a2, code := g.refresh(r1, a1.Refresh)
	if code != 200 {
		t.Fatalf("refresh: %d", code)
	}
	g.wantStatus(t, "a refreshed token passes on R2 at once", g.call(r2, "GET", "/api/v1/products", "", a2.Access, g.nextIP()), 200)

	deadline := time.Now().Add(6 * time.Second)
	for {
		w := g.call(r2, "GET", "/api/v1/products", "", a1.Access, g.nextIP())
		if w.Code == 401 && errOf(w) == "token revoked" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("R2 still accepts the revoked token after 6s: %d", w.Code)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// ---- 17: tokens issued before the claim existed ------------------------------

func (g *auGate) revokeRollout(t *testing.T) {
	c, _ := g.miniCache(t)
	userID, _ := g.newUser("cashier")
	tok, err := auth.IssueAccess(g.cfg.AccessSecret, time.Minute, userID, "cashier", auOutlet, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.wantStatus(t, "a token without pv at version 0", g.call(g.router(c), "GET", "/api/v1/products", "", tok, g.nextIP()), 200)
	g.exec(`UPDATE users SET perm_version=perm_version+1 WHERE id=$1`, userID)
	c2, _ := g.miniCache(t) // a fresh instance: no memo, no Redis key
	g.wantRevoked(t, "the same token after one bump", g.call(g.router(c2), "GET", "/api/v1/products", "", tok, g.nextIP()))
}

// ---- 18: /sync/batch with a stale token --------------------------------------

func (g *auGate) revokeSyncBatch(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	_, adminTok := g.adminToken(srv)
	userID, email := g.newUser("cashier")
	a1 := g.mustLogin(srv, email)
	g.wantStatus(t, "revoke", g.putUser(srv, adminTok, userID, map[string]any{"permissions": []string{"view_reports"}}), 200)

	raw, _ := json.Marshal(map[string]any{"items": []any{g.orderItem("revoke-sync", userID)}})
	key := auDevice + ":revoke-sync"
	w := g.call(srv, "POST", "/api/v1/sync/batch", string(raw), a1.Access, g.nextIP())
	g.wantRevoked(t, "stale token on /sync/batch (401, never 403)", w)
	if n := g.count(`SELECT count(*) FROM orders WHERE idempotency_key=$1`, key); n != 0 {
		t.Fatalf("a refused batch must create nothing, got %d orders", n)
	}
	a2, code := g.refresh(srv, a1.Refresh)
	if code != 200 {
		t.Fatalf("refresh: %d", code)
	}
	w = g.call(srv, "POST", "/api/v1/sync/batch", string(raw), a2.Access, g.nextIP())
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("resend after refresh: %d %s", w.Code, w.Body)
	}
	w = g.call(srv, "POST", "/api/v1/sync/batch", string(raw), a2.Access, g.nextIP())
	g.wantStatus(t, "resend again (idempotent)", w, 200)
	if n := g.count(`SELECT count(*) FROM orders WHERE idempotency_key=$1`, key); n != 1 {
		t.Fatalf("orders = %d, want exactly 1", n)
	}
}

// ---- 19: re-mint after a bump ------------------------------------------------

func (g *auGate) revokeRemint(t *testing.T) {
	c, _ := g.miniCache(t)
	srv := g.router(c)
	userID, email := g.newUser("cashier")
	x := g.mustLogin(srv, email)
	if _, code := g.refresh(srv, x.Refresh); code != 200 {
		t.Fatalf("rotate: %d", code)
	}
	g.exec(`UPDATE users SET perm_version=perm_version+1 WHERE id=$1`, userID)
	z, code := g.refresh(srv, x.Refresh) // replay of the rotated token re-mints its successor
	if code != 200 {
		t.Fatalf("re-mint: %d", code)
	}
	if got, want := g.claims(t, z.Access).PermVersion, g.permVersion(userID); got != want {
		t.Fatalf("re-minted access pv %d, want the current %d", got, want)
	}
	g.wantStatus(t, "the re-minted token", g.call(srv, "GET", "/api/v1/products", "", z.Access, g.nextIP()), 200)
}

// ---- 20: open-shift guards ---------------------------------------------------

func (g *auGate) openShiftGuards(t *testing.T) {
	g.ensureOutletB()
	c, _ := g.miniCache(t)
	srv := g.router(c)
	_, adminTok := g.adminToken(srv)

	// Delete: refused while a shift is open, allowed after it closes.
	del, _ := g.newUser("cashier")
	g.openShift(del)
	w := g.callH(srv, "DELETE", "/api/v1/users/"+del, "", adminTok, nil)
	if w.Code != 409 || errOf(w) != msgShiftDelete {
		t.Fatalf("delete with an open shift: %d %q", w.Code, errOf(w))
	}
	if g.count(`SELECT count(*) FROM users WHERE id=$1`, del) != 1 {
		t.Fatal("a refused delete must keep the user")
	}
	g.closeShifts(del)
	g.wantStatus(t, "delete after the shift closed", g.callH(srv, "DELETE", "/api/v1/users/"+del, "", adminTok, nil), 204)

	// Outlet move: refused whole while a shift is open.
	mv, _ := g.newUser("cashier")
	g.openShift(mv)
	before := g.permVersion(mv)
	w = g.putUser(srv, adminTok, mv, map[string]any{"displayName": "Moved Name", "outletId": auOutletB})
	if w.Code != 409 || errOf(w) != msgShiftMove {
		t.Fatalf("outlet move with an open shift: %d %q", w.Code, errOf(w))
	}
	var name, outlet string
	if err := g.pool.QueryRow(g.ctx, `SELECT display_name, outlet_id::text FROM users WHERE id=$1`, mv).Scan(&name, &outlet); err != nil {
		t.Fatal(err)
	}
	if name != "AU user" || outlet != auOutlet {
		t.Fatalf("a refused outlet move applied fields: name=%q outlet=%q", name, outlet)
	}
	// A permission-only change mid-shift is allowed, and bumps.
	g.wantStatus(t, "permission change mid-shift",
		g.putUser(srv, adminTok, mv, map[string]any{"permissions": []string{"view_reports"}}), 200)
	if got := g.permVersion(mv); got != before+1 {
		t.Fatalf("version %d, want %d", got, before+1)
	}
	// Re-sending the same outlet is not a move.
	g.wantStatus(t, "same outlet mid-shift",
		g.putUser(srv, adminTok, mv, map[string]any{"outletId": auOutlet}), 200)
	g.closeShifts(mv)
	g.wantStatus(t, "outlet move after the shift closed",
		g.putUser(srv, adminTok, mv, map[string]any{"outletId": auOutletB}), 200)

	// Store level: delete publishes a tombstone, a reset bumps once.
	rec := &recPublisher{}
	st := auth.NewStore(g.pool)
	st.Versions = rec
	gone, _ := g.newUser("cashier")
	if err := st.DeleteUser(g.ctx, gone); err != nil {
		t.Fatal(err)
	}
	if _, d := rec.snapshot(); len(d) != 1 || d[0] != gone {
		t.Fatalf("tombstones = %v", d)
	}
	rs, _ := g.newUser("cashier")
	v := g.permVersion(rs)
	if _, err := st.ResetPassword(g.ctx, rs, g.hash); err != nil {
		t.Fatal(err)
	}
	if g.permVersion(rs) != v+1 {
		t.Fatalf("reset: version %d want %d", g.permVersion(rs), v+1)
	}
}
