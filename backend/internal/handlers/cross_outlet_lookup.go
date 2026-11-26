package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

// A18 lookup guard: a per-user fixed window (the per-IP limiter still applies globally) and a log row
// for every attempt, rate-limited ones included. Order numbers are sequential, so stepping through
// other outlets' sales must be both slowed and visible.

const (
	xoKindOrderNumber = "order_number"
	xoKindPhone       = "phone"
	xoMaxQueryRunes   = 64
	xoMaxDeviceRunes  = 128
	msgXOLogFailed    = "Pencarian belum dapat dicatat. Coba lagi sebentar lagi."
)

// xoLookupRow is one cross_outlet_lookups row.
type xoLookupRow struct {
	UserID, UserName, OutletID, DeviceID string
	Kind, Value                          string
	ResultCount                          int
	RateLimited                          bool
}

// xoLogFunc writes a row; the field on Handlers lets unit tests fake it.
type xoLogFunc func(ctx context.Context, row xoLookupRow) error

// SetCrossOutletLookupLimit sets the per-user budget (config XO_LOOKUP_LIMIT / XO_LOOKUP_WINDOW_SECONDS).
func (h *Handlers) SetCrossOutletLookupLimit(limit int, window time.Duration) {
	if limit > 0 {
		h.xoLimit = limit
	}
	if window >= time.Second {
		h.xoWindow = window
	}
}

// xoBudget is the effective limit and window (defaults when never configured).
func (h *Handlers) xoBudget() (int, time.Duration) {
	limit, window := h.xoLimit, h.xoWindow
	if limit <= 0 {
		limit = config.DefaultXOLookupLimit
	}
	if window < time.Second {
		window = config.DefaultXOLookupWindowSeconds * time.Second
	}
	return limit, window
}

// xoMaskPhone keeps only the last 4 digits: "****1234".
func xoMaskPhone(norm string) string {
	if len(norm) > 4 {
		norm = norm[len(norm)-4:]
	}
	return "****" + norm
}

func xoTruncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// xoWindowAllowed counts this attempt in the caller's window. retryAfter is the time left in the
// window (>= 1 s) and is only meaningful when ok is false.
func (h *Handlers) xoWindowAllowed(ctx context.Context, userID string, now time.Time) (retryAfter int, ok bool) {
	limit, window := h.xoBudget()
	secs := int64(window.Seconds())
	bucket := now.Unix() / secs
	key := "rl:xolookup:" + userID + ":" + strconv.FormatInt(bucket, 10)
	n := h.Cache.IncrWindow(ctx, key, window)
	if n <= int64(limit) {
		return 0, true
	}
	left := secs - now.Unix()%secs
	if left < 1 {
		left = 1
	}
	return int(left), false
}

func (h *Handlers) logXOLookup(ctx context.Context, row xoLookupRow) error {
	if h.xoLog != nil {
		return h.xoLog(ctx, row)
	}
	var device any
	if row.DeviceID != "" {
		device = row.DeviceID
	}
	_, err := h.Write.Pool.Exec(ctx,
		`INSERT INTO cross_outlet_lookups (user_id, user_name, outlet_id, device_id, query_kind, query_value, result_count, rate_limited)
		 VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)`,
		row.UserID, row.UserName, row.OutletID, device, row.Kind, row.Value, row.ResultCount, row.RateLimited)
	return err
}

// xoLogOrFail writes the log row; on a failed write it answers 503 + Retry-After (fail closed: no
// result leaves without its row) and reports false.
func (h *Handlers) xoLogOrFail(w http.ResponseWriter, r *http.Request, row xoLookupRow) bool {
	if err := h.logXOLookup(r.Context(), row); err != nil {
		slog.Error("cross-outlet lookup log failed", "userId", row.UserID, "err", err)
		w.Header().Set("Retry-After", crossRefundRetryAfter)
		httpx.Err(w, http.StatusServiceUnavailable, msgXOLogFailed)
		return false
	}
	return true
}

// CrossOutletLookup is GET /cross-outlet-returns/lookup?orderNumber=... | ?phone=... [&deviceId=...]
func (h *Handlers) CrossOutletLookup(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, msgNoActiveOutlet)
		return
	}
	if !service.IsCanonicalUUID(c.outletID) {
		httpx.Err(w, http.StatusBadRequest, msgBadActiveOutlet)
		return
	}
	q := r.URL.Query()
	number, rawPhone := strings.TrimSpace(q.Get("orderNumber")), strings.TrimSpace(q.Get("phone"))
	if (number == "") == (rawPhone == "") {
		httpx.Err(w, http.StatusBadRequest, "Isi tepat satu: nomor order atau nomor HP.")
		return
	}
	row := xoLookupRow{
		UserID: c.userID, UserName: c.name, OutletID: c.outletID,
		DeviceID: xoTruncateRunes(strings.TrimSpace(q.Get("deviceId")), xoMaxDeviceRunes),
	}
	norm := ""
	if number != "" {
		row.Kind, row.Value = xoKindOrderNumber, xoTruncateRunes(number, xoMaxQueryRunes)
	} else {
		if norm = phone.Normalize(rawPhone); norm == "" {
			httpx.Err(w, http.StatusBadRequest, "Nomor HP tidak valid")
			return
		}
		row.Kind, row.Value = xoKindPhone, xoMaskPhone(norm)
	}
	if retryAfter, ok := h.xoWindowAllowed(r.Context(), c.userID, time.Now()); !ok {
		row.RateLimited = true
		if !h.xoLogOrFail(w, r, row) {
			return
		}
		slog.Warn("cross-outlet lookup rate limited", "userId", c.userID, "outletId", c.outletID, "ip", clientip.ClientIPBucket(r))
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		httpx.Err(w, http.StatusTooManyRequests, "Terlalu banyak pencarian. Coba lagi dalam "+strconv.Itoa((retryAfter+59)/60)+" menit.")
		return
	}
	var (
		rows []api.CrossOutletOrder
		err  error
	)
	if number != "" {
		rows, err = h.Repo.CrossOutletByNumber(r.Context(), c.outletID, number)
	} else {
		rows, err = h.Repo.CrossOutletByPhone(r.Context(), c.outletID, norm)
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if rows == nil {
		rows = []api.CrossOutletOrder{}
	}
	row.ResultCount = len(rows)
	if !h.xoLogOrFail(w, r, row) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

// xoParseBound reads a from/to filter: RFC 3339, or a bare YYYY-MM-DD meaning that Asia/Jakarta day
// (endOfDay turns it into the start of the next day, so `to` stays exclusive and inclusive of the day).
func xoParseBound(v string, endOfDay bool) (*time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return &t, true
	}
	loc, err := time.LoadLocation("Asia/Jakarta")
	if err != nil {
		loc = time.FixedZone("WIB", 7*3600)
	}
	d, err := time.ParseInLocation("2006-01-02", v, loc)
	if err != nil {
		return nil, false
	}
	if endOfDay {
		d = d.AddDate(0, 0, 1)
	}
	return &d, true
}

// CrossOutletLookups is GET /cross-outlet-returns/lookups (admin route): the paginated lookup log.
func (h *Handlers) CrossOutletLookups(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := read.CrossOutletLookupFilter{UserID: strings.ToLower(q.Get("userId")), OutletID: strings.ToLower(q.Get("outletId"))}
	for _, id := range []string{f.UserID, f.OutletID} {
		if id != "" && !service.IsCanonicalUUID(id) {
			httpx.Err(w, http.StatusBadRequest, "Filter tidak valid.")
			return
		}
	}
	var ok1, ok2 bool
	f.From, ok1 = xoParseBound(q.Get("from"), false)
	f.To, ok2 = xoParseBound(q.Get("to"), true)
	if !ok1 || !ok2 {
		httpx.Err(w, http.StatusBadRequest, "Tanggal tidak valid.")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.CrossOutletLookups(r.Context(), f, p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.CrossOutletLookupLogListResponse{Data: rows, Meta: meta(total, p, l)})
}
