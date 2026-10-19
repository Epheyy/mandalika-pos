package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/phone"
)

// Phone-only lookup budget per terminal account (A30, owner decision Q4). The key is the
// user, not the IP: an outlet's tablets share one NAT and usually one terminal account.
const (
	lookupPerMinute = 30
	lookupPerDay    = 400
	// lookupMaxRows caps how many soft duplicates of one phone a cashier can see.
	lookupMaxRows = 3
)

// lookupLimitDecision turns the two window counters (this request included) into a
// verdict. When limited it returns the seconds until the longest exceeded window resets.
func lookupLimitDecision(minuteCount, dayCount int64, now time.Time) (retryAfter int, limited bool) {
	now = now.UTC()
	if minuteCount > lookupPerMinute {
		retryAfter = 60 - now.Second()
		limited = true
	}
	if dayCount > lookupPerDay {
		nextDay := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
		retryAfter = int(nextDay.Sub(now).Seconds())
		limited = true
	}
	return retryAfter, limited
}

// lookupKeys are the per-user minute and day counter keys for the window containing now.
func lookupKeys(uid string, now time.Time) (minuteKey, dayKey string) {
	return "rl:custlookup:m:" + uid + ":" + strconv.FormatInt(now.Unix()/60, 10),
		"rl:custlookup:d:" + uid + ":" + now.UTC().Format("20060102")
}

// lookupAllowed counts one real lookup against the caller's minute and day windows.
func (h *Handlers) lookupAllowed(r *http.Request) (retryAfter int, ok bool) {
	return h.lookupAllowedAt(r, time.Now())
}

// lookupAllowedAt is lookupAllowed at a given instant. A request the minute window already
// refuses does not touch the day counter: hammering the button must not eat the day's budget.
func (h *Handlers) lookupAllowedAt(r *http.Request, now time.Time) (retryAfter int, ok bool) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	minuteKey, dayKey := lookupKeys(uid, now)
	m := h.Cache.IncrWindow(r.Context(), minuteKey, time.Minute)
	if m > lookupPerMinute {
		retryAfter, _ = lookupLimitDecision(m, 0, now)
		return retryAfter, false
	}
	d := h.Cache.IncrWindow(r.Context(), dayKey, 24*time.Hour)
	retryAfter, limited := lookupLimitDecision(m, d, now)
	return retryAfter, !limited
}

// CustomersLookup is the cashier's customer finder. It is never cached: the result is
// role-dependent and a shared cache key must not serve one role's rows to another.
//
//   - customerScope All: `phone` (what the POS sends) finds the customers with that phone,
//     full object; otherwise the backoffice typeahead (`q`, name/phone substring). With
//     neither, the answer is empty: nobody gets the customer table from this endpoint.
//   - PhoneOnly (cashier): an exact match on the normalized phone only, at most 3 rows,
//     reduced fields, rate limited. Names and short or malformed input return [].
func (h *Handlers) CustomersLookup(w http.ResponseWriter, r *http.Request) {
	if customerScope(r) == CustomerAll {
		h.lookupForReader(w, r)
		return
	}
	raw := r.URL.Query().Get("phone")
	if raw == "" {
		raw = r.URL.Query().Get("q") // legacy clients send the typed text as q
	}
	norm := phone.Normalize(raw)
	if norm == "" {
		writeJSON(w, http.StatusOK, api.CustomerListResponse{Data: []api.Customer{}, Meta: meta(0, 1, 0)})
		return
	}
	if retryAfter, ok := h.lookupAllowed(r); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		httpx.Err(w, http.StatusTooManyRequests, "terlalu banyak pencarian, coba lagi nanti")
		return
	}
	rows, err := h.Repo.CustomerByPhoneNorm(r.Context(), norm, lookupMaxRows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.CustomerListResponse{Data: rows, Meta: meta(len(rows), 1, len(rows))})
}

// lookupForReader serves callers who may browse customers (not rate limited, full objects).
func (h *Handlers) lookupForReader(w http.ResponseWriter, r *http.Request) {
	rows := []api.Customer{}
	var err error
	if raw := strings.TrimSpace(r.URL.Query().Get("phone")); raw != "" {
		// An explicit phone is never a name search: a POS login of a manager sends only this.
		if phone.Normalize(raw) != "" {
			rows, err = h.Repo.CustomerByPhone(r.Context(), raw)
		}
	} else if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		rows, err = h.Repo.CustomerLookup(r.Context(), q, limit)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.CustomerListResponse{Data: rows, Meta: meta(len(rows), 1, len(rows))})
}
