package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
)

type Handler struct {
	Cfg   *config.Config
	Store *Store
	Cache *cache.Cache
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

// rate limit: 10 login attempts / 5 min per IP+email.
func (h *Handler) rateLimited(ctx context.Context, key string) bool {
	n := h.Cache.Incr(ctx, "rl:login:"+key, 5*time.Minute)
	return n > 10
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	ip := strings.Split(r.RemoteAddr, ":")[0]
	if h.rateLimited(r.Context(), ip+":"+req.Email) {
		httpx.Err(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	u, err := h.Store.Authenticate(r.Context(), strings.ToLower(req.Email), req.Password)
	if err != nil {
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
	// Reuse-detection: jti must still be present and not revoked.
	if _, ok := h.Cache.Get(r.Context(), "refresh:"+rc.ID); !ok {
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
