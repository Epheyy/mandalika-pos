package handlers

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// MsgBundleAdminOnly is the refusal shown when a non-admin tries to change bundle prices,
// outlet price-group assignments or price groups.
const MsgBundleAdminOnly = "Hanya admin yang bisa mengubah harga bundle."

// RequireBundleAdmin lets only the admin role through. Owner decision 2026-11-28: bundle
// prices are admin-only, so even a "Semua Outlet" manager with manage_products is refused.
func RequireBundleAdmin() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if role, _ := r.Context().Value(auth.CtxRole).(string); role != "admin" {
				httpx.Err(w, http.StatusForbidden, MsgBundleAdminOnly)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
