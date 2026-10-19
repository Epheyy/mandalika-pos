package handlers

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// CustomerAccess is how much of the customer base the caller may browse (A30).
type CustomerAccess int

const (
	// CustomerPhoneOnly: the caller may only find a customer by an exact phone number.
	CustomerPhoneOnly CustomerAccess = iota
	// CustomerAll: the caller may browse, search and read every customer of this
	// deployment (one deployment per brand, so "own brand" is the whole database).
	CustomerAll
)

// customerScope is the single place that decides customer visibility. Admin sees all;
// a cashier is phone-only even when granted manage_customers (owner decision Q2);
// anyone else needs manage_customers. If brands ever share a deployment, a brand
// filter grows here and nowhere else.
func customerScope(r *http.Request) CustomerAccess {
	role, _ := r.Context().Value(auth.CtxRole).(string)
	switch {
	case role == "admin":
		return CustomerAll
	case role == "" || role == "cashier":
		return CustomerPhoneOnly
	case auth.HasPermission(r.Context(), "manage_customers"):
		return CustomerAll
	}
	return CustomerPhoneOnly
}

// RequireCustomerReader guards every route that exposes customer data beyond an exact
// phone lookup: only customerScope == CustomerAll passes, everyone else gets 403.
func RequireCustomerReader() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if customerScope(r) == CustomerAll {
				next.ServeHTTP(w, r)
				return
			}
			httpx.Err(w, http.StatusForbidden, "customer access denied")
		})
	}
}
