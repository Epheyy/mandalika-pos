package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// RevocationChecker reports a user's current rights version (see auth.PermVersions).
type RevocationChecker interface {
	Current(ctx context.Context, uid string) (int64, bool, error)
	Observe(uid string, pv int64)
}

type authOptions struct{ revocation RevocationChecker }

// AuthOption configures RequireAuth.
type AuthOption func(*authOptions)

// WithRevocation makes RequireAuth refuse access tokens issued before the user's
// rights last changed (or whose user is gone) with a refreshable 401.
func WithRevocation(c RevocationChecker) AuthOption {
	return func(o *authOptions) { o.revocation = c }
}

const authUnavailableRetryAfter = "2"

func RequireAuth(cfg *config.Config, opts ...AuthOption) func(http.Handler) http.Handler {
	var o authOptions
	for _, opt := range opts {
		opt(&o)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			if !strings.HasPrefix(h, "Bearer ") {
				httpx.Err(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			claims, err := auth.ParseAccess(cfg.AccessSecret, strings.TrimPrefix(h, "Bearer "))
			if err != nil {
				httpx.Err(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}
			// Rights version, before the outlet check: a stale token must get a
			// refreshable 401, never the 403 below (clients do not refresh on 403).
			// Only the middleware answers 401 here, so a client that refreshes and
			// retries never resends a request a handler refused for a business reason.
			// /auth/me is not refreshed by the client: a stale token there signs out.
			if o.revocation != nil {
				cur, exists, err := o.revocation.Current(r.Context(), claims.UserID)
				if err != nil {
					slog.Warn("auth_version_unavailable", "user", claims.UserID, "err", err)
					w.Header().Set("Retry-After", authUnavailableRetryAfter)
					httpx.Err(w, http.StatusServiceUnavailable, "auth temporarily unavailable")
					return
				}
				if auth.Revoked(claims.PermVersion, cur, exists) {
					slog.Info("access_token_revoked", "user", claims.UserID, "pv", claims.PermVersion, "current", cur)
					httpx.Err(w, http.StatusUnauthorized, "token revoked")
					return
				}
				o.revocation.Observe(claims.UserID, claims.PermVersion)
			}
			ctx := context.WithValue(r.Context(), auth.CtxUserID, claims.UserID)
			ctx = context.WithValue(ctx, auth.CtxRole, claims.Role)
			// Active outlet: X-Outlet-Id header validated against token, else token outlet.
			outlet := claims.OutletID
			if h := r.Header.Get("X-Outlet-Id"); h != "" {
				if claims.Role == "admin" || h == claims.OutletID {
					outlet = h
				} else {
					httpx.Err(w, http.StatusForbidden, "outlet not permitted")
					return
				}
			}
			ctx = context.WithValue(ctx, auth.CtxOutletID, outlet)
			ctx = context.WithValue(ctx, auth.CtxPerms, claims.Permissions)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, _ := r.Context().Value(auth.CtxRole).(string)
			if !allowed[role] {
				httpx.Err(w, http.StatusForbidden, "insufficient role")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RequirePermission(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if auth.HasPermission(r.Context(), perm) {
				next.ServeHTTP(w, r)
				return
			}
			httpx.Err(w, http.StatusForbidden, "missing permission: "+perm)
		})
	}
}

// RequireRecipesEnabled returns 404 when the Recipe/Formula module is
// turned off in app_settings. We return 404 (not 403) so deployments
// without the module look like the routes don't exist.
func RequireRecipesEnabled(rd interface {
	RecipesEnabled(ctx context.Context) (bool, error)
}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			on, err := rd.RecipesEnabled(r.Context())
			if err != nil {
				httpx.Err(w, http.StatusInternalServerError, "settings read failed")
				return
			}
			if !on {
				httpx.Err(w, http.StatusNotFound, "not found")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
