package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// reviewReportBodyLimit bounds a check-in body (the tablet sends at most 50 items).
const reviewReportBodyLimit = 8 << 20

// ReportSyncReviewItems: POST /sync/review-items (tablet check-in). The outlet
// comes from the caller's auth context, never from the body.
func (h *Handlers) ReportSyncReviewItems(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, reviewReportBodyLimit)
	var body struct {
		Items []reviewReportIn `json:"items"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	items, err := normalizeReviewReports(body.Items)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	c, _ := h.caller(r)
	if c.outletID == "" || c.userID == "" {
		httpx.Err(w, http.StatusBadRequest, "outlet terminal tidak diketahui")
		return
	}
	resolved := []write.SyncReviewResolution{}
	if len(items) > 0 {
		resolved, err = h.Write.UpsertSyncReviewReports(r.Context(), c.outletID, c.userID, items)
		if err != nil {
			slog.Error("sync review report failed", "outletId", c.outletID, "err", err)
			httpx.Err(w, http.StatusInternalServerError, "gagal menyimpan item tinjauan")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"resolved": resolved})
}

// ListSyncReviewItems: GET /sync-review-items (head office, all outlets).
func (h *Handlers) ListSyncReviewItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = "open"
	}
	if status != "open" && status != "resolved" {
		httpx.Err(w, http.StatusBadRequest, "status must be open or resolved")
		return
	}
	outletID := q.Get("outletId")
	if _, err := uuid.Parse(outletID); outletID != "" && err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid outletId")
		return
	}
	code := strings.TrimSpace(q.Get("reviewCode"))
	if len(code) > maxReviewCodeLen {
		httpx.Err(w, http.StatusBadRequest, "invalid reviewCode")
		return
	}
	page, limit := pageLimit(r)
	items, total, err := h.Repo.SyncReviewItems(r.Context(), read.SyncReviewFilter{
		Status: status, OutletID: outletID, ReviewCode: code, Page: page, Limit: limit,
	})
	if err != nil {
		slog.Error("sync review list failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat item tinjauan")
		return
	}
	open, err := h.Repo.SyncReviewOpenCount(r.Context())
	if err != nil {
		slog.Error("sync review count failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat item tinjauan")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items, "meta": meta(total, page, limit), "openCount": open})
}

// ResolveSyncReviewItem: POST /sync-review-items/{key}/resolve. The key arrives
// percent-encoded (it contains ':'), and chi hands back the raw segment.
func (h *Handlers) ResolveSyncReviewItem(w http.ResponseWriter, r *http.Request) {
	key, err := url.PathUnescape(chi.URLParam(r, "key"))
	if err != nil || key == "" || len(key) > maxReviewKeyLen {
		httpx.Err(w, http.StatusBadRequest, "invalid key")
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	note, err := normalizeResolveNote(body.Note)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	res, err := h.Write.ResolveSyncReviewItem(r.Context(), key, uid, note)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		slog.Error("sync review resolve failed", "key", key, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal menyelesaikan item")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
