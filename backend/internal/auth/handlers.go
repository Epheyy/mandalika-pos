package auth

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
)

type Handler struct {
	Cfg   *config.Config
	Store *Store
	Cache *cache.Cache

	// reset overrides Store for admin password reset (tests); nil uses Store.
	reset resetStore
	// now overrides time.Now for the reset marker (tests); nil uses time.Now.
	now func() time.Time
}

func NewHandler(cfg *config.Config, store *Store, c *cache.Cache) *Handler {
	return &Handler{Cfg: cfg, Store: store, Cache: c}
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResp struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
	User    *User  `json:"user"`
}

func (h *Handler) issue(ctx context.Context, u *User) (*authResp, error) {
	access, err := IssueAccess(h.Cfg.AccessSecret, h.Cfg.AccessTTL, u.ID, u.Role, u.OutletID, u.Permissions)
	if err != nil {
		return nil, err
	}
	refresh, jti, err := IssueRefresh(h.Cfg.RefreshSecret, h.Cfg.RefreshTTL, u.ID)
	if err != nil {
		return nil, err
	}
	// Store refresh jti in Redis (fast revocation) + Postgres (durable).
	h.Cache.Set(ctx, "refresh:"+jti, u.ID, h.Cfg.RefreshTTL)
	_, _ = h.Store.Pool.Exec(ctx,
		`INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)`,
		jti, u.ID, time.Now().Add(h.Cfg.RefreshTTL))
	return &authResp{Access: access, Refresh: refresh, User: u}, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// loginRateKey scopes login attempts to client-IP bucket + normalized email.
func loginRateKey(ipBucket, email string) string {
	return ipBucket + ":" + normalizeEmail(email)
}

// rate limit: 10 login attempts / 5 min per IP+email.
func (h *Handler) rateLimited(ctx context.Context, key string) bool {
	n := h.Cache.Incr(ctx, "rl:login:"+key, 5*time.Minute)
	return n > 10
}

// Per-account cap on FAILED logins, regardless of client IP, so rotating
// addresses (e.g. across an IPv6 /48) can't brute-force one account. Kept
// generous because an attacker can also use it to lock an account out.
const (
	loginEmailFailLimit  = 30
	loginEmailFailWindow = 15 * time.Minute
)

func loginEmailKey(email string) string {
	return "rl:login:email:" + normalizeEmail(email)
}

// emailCapReached reports whether a stored failure count has hit the cap.
func emailCapReached(stored string, ok bool) bool {
	if !ok {
		return false
	}
	n, err := strconv.Atoi(stored)
	return err == nil && n >= loginEmailFailLimit
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if h.rateLimited(r.Context(), loginRateKey(clientip.ClientIPBucket(r), req.Email)) {
		httpx.Err(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	emailKey := loginEmailKey(req.Email)
	if emailCapReached(h.Cache.Get(r.Context(), emailKey)) {
		httpx.Err(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	u, err := h.Store.Authenticate(r.Context(), normalizeEmail(req.Email), req.Password)
	if err != nil {
		h.Cache.Incr(r.Context(), emailKey, loginEmailFailWindow)
		httpx.Err(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	resp, err := h.issue(r.Context(), u)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token issue failed")
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}

type refreshReq struct {
	Refresh string `json:"refresh"`
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	rc, err := ParseRefresh(h.Cfg.RefreshSecret, req.Refresh)
	if err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	// Reuse-detection: jti must still be present and not revoked, and the
	// token must not predate an admin password reset for this user.
	if !h.refreshUsable(r.Context(), rc) {
		httpx.Err(w, http.StatusUnauthorized, "refresh token expired or revoked")
		return
	}
	// Rotate: revoke old jti, issue new pair.
	h.Cache.Del(r.Context(), "refresh:"+rc.ID)
	_, _ = h.Store.Pool.Exec(r.Context(),
		`UPDATE refresh_tokens SET revoked=true WHERE jti=$1`, rc.ID)
	u, err := h.Store.ByID(r.Context(), rc.UserID)
	if err != nil {
		httpx.Err(w, http.StatusUnauthorized, "user not found")
		return
	}
	resp, err := h.issue(r.Context(), u)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token issue failed")
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := httpx.Decode(r, &req); err == nil && req.Refresh != "" {
		if rc, err := ParseRefresh(h.Cfg.RefreshSecret, req.Refresh); err == nil {
			h.Cache.Del(r.Context(), "refresh:"+rc.ID)
			_, _ = h.Store.Pool.Exec(r.Context(),
				`UPDATE refresh_tokens SET revoked=true WHERE jti=$1`, rc.ID)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value(CtxUserID).(string)
	if uid == "" {
		httpx.Err(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	u, err := h.Store.ByID(r.Context(), uid)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "user not found")
		return
	}
	httpx.JSON(w, http.StatusOK, u)
}

// refreshUsable reports whether a parsed refresh token may still be exchanged:
// its jti is live in Redis and it was not issued before the user's last admin
// password reset (refresh_revoked_before marker).
func (h *Handler) refreshUsable(ctx context.Context, rc *RefreshClaims) bool {
	if _, ok := h.Cache.Get(ctx, "refresh:"+rc.ID); !ok {
		return false
	}
	marker, hasMarker := h.Cache.Get(ctx, refreshRevokedKey(rc.UserID))
	return !refreshRevoked(rc.IssuedAt, marker, hasMarker)
}

// refreshRevoked reports whether a token with the given iat predates the
// per-user marker (unix seconds). A marker that exists but cannot be parsed,
// or a token without iat, is treated as revoked (fail closed).
func refreshRevoked(iat *jwt.NumericDate, marker string, hasMarker bool) bool {
	if !hasMarker {
		return false
	}
	before, err := strconv.ParseInt(marker, 10, 64)
	if err != nil || iat == nil {
		return true
	}
	return iat.Unix() < before
}
