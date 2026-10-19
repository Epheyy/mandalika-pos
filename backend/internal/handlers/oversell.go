package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/bizday"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

const (
	oversellAckMaxIDs  = 200
	oversellNoteMax    = 500
	oversellAckBodyMax = 16 << 10
)

func validOptionalUUID(s string) bool {
	if s == "" {
		return true
	}
	_, err := uuid.Parse(s)
	return err == nil
}

// OversellReport: GET /oversell-report (A44 "Stok Minus"), view_reports. The outlet
// comes from scope(r) only; a raw ?outletId is never trusted (grant-report IDOR lesson).
func (h *Handlers) OversellReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind, status := q.Get("kind"), q.Get("status")
	switch {
	case !bizday.ValidDay(q.Get("dateFrom")) || !bizday.ValidDay(q.Get("dateTo")):
		httpx.Err(w, http.StatusBadRequest, "tanggal tidak valid (YYYY-MM-DD)")
		return
	case !validOptionalUUID(q.Get("productId")) || !validOptionalUUID(q.Get("cashierId")):
		httpx.Err(w, http.StatusBadRequest, "id tidak valid")
		return
	case kind != "" && kind != "shortage" && kind != "unresolved_variant" && kind != "refund_unresolved_variant":
		httpx.Err(w, http.StatusBadRequest, "kind tidak valid")
		return
	case status != "" && status != "open" && status != "acknowledged":
		httpx.Err(w, http.StatusBadRequest, "status tidak valid")
		return
	case len(q.Get("variantSize")) > 100:
		httpx.Err(w, http.StatusBadRequest, "variantSize tidak valid")
		return
	}
	p, l := pageLimit(r)
	f := read.OversellFilters{
		DateFrom: q.Get("dateFrom"), DateTo: q.Get("dateTo"),
		OutletID:  scope(r).OutletID,
		ProductID: q.Get("productId"), VariantSize: q.Get("variantSize"),
		CashierID: q.Get("cashierId"), Kind: kind, Status: status,
	}
	summary, rows, total, err := h.Repo.SaleStockExceptionReport(r.Context(), f, p, l)
	if err != nil {
		slog.Error("oversell report failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat laporan stok minus")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "data": rows, "meta": meta(total, p, l)})
}

// OversellOpenCount: GET /oversell-report/open-count, view_reports (badge).
func (h *Handlers) OversellOpenCount(w http.ResponseWriter, r *http.Request) {
	n, err := h.Repo.OversellOpenCount(r.Context(), scope(r).OutletID)
	if err != nil {
		slog.Error("oversell open count failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat jumlah stok minus")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]int{"openCount": n})
}

// AcknowledgeOversell: POST /oversell-records/acknowledge, manage_stock_count (Q1).
// Idempotent: lines already checked or outside the caller's outlet scope are skipped.
func (h *Handlers) AcknowledgeOversell(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, oversellAckBodyMax)
	var body struct {
		IDs  []string `json:"ids"`
		Note string   `json:"note"`
	}
	if err := httpx.Decode(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	note := strings.TrimSpace(body.Note)
	if len(body.IDs) == 0 || len(body.IDs) > oversellAckMaxIDs || len([]rune(note)) > oversellNoteMax {
		httpx.Err(w, http.StatusBadRequest, "ids 1-200, catatan maks 500 karakter")
		return
	}
	for _, id := range body.IDs {
		if _, err := uuid.Parse(id); err != nil {
			httpx.Err(w, http.StatusBadRequest, "id tidak valid")
			return
		}
	}
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	n, err := h.Write.AcknowledgeSaleStockExceptions(r.Context(), body.IDs, scope(r).OutletID, uid, note)
	if err != nil {
		slog.Error("oversell acknowledge failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal menandai sudah dicek")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]int{"acknowledged": n})
}
