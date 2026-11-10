package handlers

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

const (
	keysetDefaultLimit = 50
	keysetMaxLimit     = 1000
)

// keysetParams validates the export-mode query of GET /orders (paging=keyset). It returns a
// user-facing message when the request is invalid; there is no silent clamp in this mode.
func keysetParams(q url.Values, refundBasis bool) (limit int, cursor *read.OrderCursor, msg string) {
	if q.Get("paging") != "keyset" {
		if q.Get("paging") != "" {
			return 0, nil, "paging tidak valid"
		}
		return 0, nil, "cursor memerlukan paging=keyset"
	}
	if p, _ := strconv.Atoi(q.Get("page")); p > 1 {
		return 0, nil, "paging=keyset tidak bisa digabung dengan page"
	}
	if refundBasis {
		return 0, nil, "paging=keyset tidak mendukung dateBasis=refund"
	}
	limit = keysetDefaultLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > keysetMaxLimit {
			return 0, nil, "limit harus 1-1000 untuk paging=keyset"
		}
		limit = n
	}
	if s := q.Get("cursor"); s != "" {
		c, err := read.DecodeOrderCursor(s)
		if err != nil {
			return 0, nil, "cursor tidak valid"
		}
		cursor = &c
	}
	return limit, cursor, ""
}

// isKeysetRequest reports whether the request uses the export mode params at all.
func isKeysetRequest(q url.Values) bool { return q.Get("paging") != "" || q.Get("cursor") != "" }

// ordersKeyset serves one export page. Never cached: about 2 MB a page, a unique key, never
// re-read, and a stale page would break the export's exact-count check.
func (h *Handlers) ordersKeyset(w http.ResponseWriter, r *http.Request, f read.OrderFilter) {
	limit, cursor, msg := keysetParams(r.URL.Query(), f.DateBasis == "refund")
	if msg != "" {
		httpx.Err(w, http.StatusBadRequest, msg)
		return
	}
	rows, total, next, asOf, err := h.Repo.OrdersKeyset(r.Context(), f, cursor, limit)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	resp := api.OrderListResponse{Data: rows, Meta: meta(total, 1, limit), AsOf: &asOf}
	if next != nil {
		s := read.EncodeOrderCursor(*next)
		resp.NextCursor = &s
	}
	writeJSON(w, http.StatusOK, resp)
}
