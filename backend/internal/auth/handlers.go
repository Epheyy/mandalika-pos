package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// authBackend is the Postgres surface the handlers need (faked in tests).
type authBackend interface {
	Authenticate(ctx context.Context, email, password string) (*User, string, error)
	ByID(ctx context.Context, id string) (*User, error)
	IssueSession(ctx context.Context, u *User, verifiedHash string, s Session) error
	RotateSession(ctx context.Context, in RotateInput) (*RotateResult, error)
	RevokeFamily(ctx context.Context, uid, jti string) ([]string, error)
}

type Handler struct {
	Cfg   *config.Config
	Store *Store
	Cache *cache.Cache

	// backend overrides Store for sessions/credentials (tests); nil uses Store.
	backend authBackend
	// reset overrides Store for admin password reset (tests); nil uses Store.
	reset resetStore
	// now overrides time.Now for the reset marker and session times (tests).
	now func() time.Time
}

func NewHandler(cfg *config.Config, store *Store, c *cache.Cache) *Handler {
	return &Handler{Cfg: cfg, Store: store, Cache: c}
}

func (h *Handler) be() authBackend {
	if h.backend != nil {
		return h.backend
	}
	return h.Store
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

// newSession builds a session whose iat/exp are second-truncated so the row and
// the signed JWT carry identical values.
func (h *Handler) newSession() Session {
	iat := h.clock().Truncate(time.Second)
	return Session{JTI: uuid.NewString(), IssuedAt: iat, ExpiresAt: iat.Add(h.Cfg.RefreshTTL)}
}

// respond signs the token pair for a session that is already durable.
func (h *Handler) respond(u *User, s Session) (*authResp, error) {
	access, err := IssueAccess(h.Cfg.AccessSecret, h.Cfg.AccessTTL, u.ID, u.Role, u.OutletID, u.Permissions)
	if err != nil {
		return nil, err
	}
	refresh, err := SignRefresh(h.Cfg.RefreshSecret, u.ID, s.JTI, s.IssuedAt, s.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &authResp{Access: access, Refresh: refresh, User: u}, nil
}

// mirrorSession writes the legacy Redis key (rollback compatibility, D5): best
// effort, after the Postgres commit, never read on the normal path. TTL is the
// token's remaining life.
//
// Every miss is logged as `refresh_mirror_failed` (user id and err only, no token
// values): the RUNBOOK rollback check greps for it, because a rollback to the
// previous revision trusts these keys.
func (h *Handler) mirrorSession(ctx context.Context, uid string, s Session, oldJTI string) {
	if ttl := time.Until(s.ExpiresAt); ttl > 0 {
		if err := h.Cache.SetE(ctx, "refresh:"+s.JTI, uid, ttl); err != nil {
			slog.Warn("refresh_mirror_failed", "op", "set", "user", uid, "err", err)
		}
	}
	if oldJTI != "" {
		if err := h.Cache.DelE(ctx, "refresh:"+oldJTI); err != nil {
			slog.Warn("refresh_mirror_failed", "op", "del", "user", uid, "err", err)
		}
	}
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// emailDigest is a truncated sha256 of the normalized email. Limiter keys (Redis
// and the in-memory fallback) use it so the raw email is never stored or logged,
// and the key length stays bounded whatever the client sends.
func emailDigest(email string) string {
	sum := sha256.Sum256([]byte(normalizeEmail(email)))
	return hex.EncodeToString(sum[:16])
}

// loginRateKey scopes login attempts to client-IP bucket + normalized email.
func loginRateKey(ipBucket, email string) string {
	return ipBucket + ":" + emailDigest(email)
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
	return "rl:login:email:" + emailDigest(email)
}

// emailCapReached reports whether a failure count has hit the per-account cap.
func emailCapReached(n int64) bool { return n >= loginEmailFailLimit }

// maxLoginBody caps the login body. Login ONLY: /auth/refresh must never answer
// 413, because the client treats any non-5xx/429 non-OK refresh status as
// "rejected" and logs the tablet out.
const maxLoginBody = 8 << 10

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBody)
	if err := httpx.Decode(r, &req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, "request too large")
			return
		}
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	ctx := r.Context()
	if h.rateLimited(ctx, loginRateKey(clientip.ClientIPBucket(r), req.Email)) {
		httpx.Err(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	emailKey := loginEmailKey(req.Email)
	if emailCapReached(h.Cache.Count(ctx, emailKey)) {
		httpx.Err(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	u, hash, err := h.be().Authenticate(ctx, normalizeEmail(req.Email), req.Password)
	if errors.Is(err, ErrNotFound) {
		h.Cache.Incr(ctx, emailKey, loginEmailFailWindow)
		httpx.Err(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		slog.Error("login_lookup_failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "login failed")
		return
	}
	// Durable first: tokens are signed only after the session row committed.
	sess := h.newSession()
	if err := h.be().IssueSession(ctx, u, hash, sess); err != nil {
		if errors.Is(err, ErrCredentialsChanged) || errors.Is(err, ErrNotFound) {
			// A concurrent admin reset replaced the password we just verified.
			httpx.Err(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
		slog.Error("session_issue_failed", "err", err, "user", u.ID)
		httpx.Err(w, http.StatusInternalServerError, "token issue failed")
		return
	}
	resp, err := h.respond(u, sess)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token issue failed")
		return
	}
	h.mirrorSession(ctx, u.ID, sess, "")
	httpx.JSON(w, http.StatusOK, resp)
}

type refreshReq struct {
	Refresh string `json:"refresh"`
}

// Refresh answers only 200, 401 (a definitive no), 429 (limiter), or 5xx (no
// verdict; the client keeps the session) -- plus 400 for a malformed body the
// client never sends. The client treats any other non-OK status as "rejected"
// and logs the tablet out.
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
	ctx := r.Context()
	res, err := h.be().RotateSession(ctx, RotateInput{Claims: rc, New: h.newSession(), Adopt: h.adoptLegacy})
	switch {
	case errors.Is(err, ErrRefreshRejected):
		httpx.Err(w, http.StatusUnauthorized, "refresh token expired or revoked")
		return
	case errors.Is(err, ErrNotFound):
		httpx.Err(w, http.StatusUnauthorized, "user not found")
		return
	case err != nil:
		slog.Error("refresh_unavailable", "err", err, "user", rc.UserID)
		httpx.Err(w, http.StatusServiceUnavailable, "auth temporarily unavailable")
		return
	}
	resp, err := h.respond(res.User, res.Session)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token issue failed")
		return
	}
	h.mirrorSession(ctx, res.User.ID, res.Session, rc.ID)
	httpx.JSON(w, http.StatusOK, resp)
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := httpx.Decode(r, &req); err == nil && req.Refresh != "" {
		if rc, err := ParseRefresh(h.Cfg.RefreshSecret, req.Refresh); err == nil {
			ctx := r.Context()
			revoked, err := h.be().RevokeFamily(ctx, rc.UserID, rc.ID)
			if err != nil {
				slog.Error("logout_revoke_failed", "err", err, "user", rc.UserID)
			}
			keys := []string{"refresh:" + rc.ID}
			for _, j := range revoked {
				keys = append(keys, "refresh:"+j)
			}
			if err := h.Cache.DelE(ctx, keys...); err != nil {
				slog.Warn("refresh_mirror_failed", "op", "del", "user", rc.UserID, "err", err)
			}
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
	u, err := h.be().ByID(r.Context(), uid)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "user not found")
		return
	}
	httpx.JSON(w, http.StatusOK, u)
}

// adoptLegacy is the D4 migration source: a refresh token with NO row whose
// Redis key still exists is adopted, unless a Redis reset marker kills it.
// Redis unreachable or disabled means no verdict (503), never a logout.
func (h *Handler) adoptLegacy(ctx context.Context, rc *RefreshClaims) (bool, error) {
	v, found, err := h.Cache.GetE(ctx, "refresh:"+rc.ID)
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrAdoptionUnavailable, err)
	}
	if !found || v != rc.UserID {
		return false, nil
	}
	marker, hasMarker, err := h.Cache.GetE(ctx, refreshRevokedKey(rc.UserID))
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrAdoptionUnavailable, err)
	}
	if refreshRevoked(rc.IssuedAt, marker, hasMarker) {
		return false, nil
	}
	return true, nil
}

// refreshRevoked reports whether a legacy token with the given iat is killed by
// the Redis reset marker (unix seconds): iat <= marker. A marker that exists but
// cannot be parsed, or a token without iat, is treated as revoked (fail closed).
func refreshRevoked(iat *jwt.NumericDate, marker string, hasMarker bool) bool {
	if !hasMarker {
		return false
	}
	before, err := strconv.ParseInt(marker, 10, 64)
	if err != nil || iat == nil {
		return true
	}
	return iat.Unix() <= before
}
