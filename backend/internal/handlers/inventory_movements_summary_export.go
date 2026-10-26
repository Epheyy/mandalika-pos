package handlers

import (
	"context"
	"encoding/csv"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// movementSummaryCSVHeader is the Pergerakan export header: the same columns and bucket names as
// the screen (signed numbers; saldo_awal + the six buckets = saldo_akhir).
var movementSummaryCSVHeader = []string{"produk", "ukuran", "sku", "barcode", "saldo_awal", "masuk", "penjualan",
	"refund", "transfer", "penyesuaian", "hadiah", "saldo_akhir", "masuk_garansi"}

func movementSummaryCSVRow(r api.MovementLedgerSummaryRow) []string {
	g := csvimport.GuardCell
	n := strconv.Itoa
	b := r.Buckets
	return []string{g(r.ProductName), g(r.VariantSize), g(r.Sku), g(deref(r.Barcode)), n(r.Opening), n(b.Masuk), n(b.Penjualan),
		n(b.Refund), n(b.Transfer), n(b.Penyesuaian), n(b.Hadiah), n(r.Closing), n(r.MasukGaransi)}
}

// ExportMovementLedgerSummary is Pergerakan as CSV: same filters as the summary, from and to
// required, at most 93 days and 100000 SKU rows (413 above). The rows are read before the first
// byte is written, so a failure is a clean error response, never a truncated 200.
func (h *Handlers) ExportMovementLedgerSummary(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), movementExportTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(movementExportWriteDeadline))
	f, _, ok := h.movementFilter(w, r)
	if !ok {
		return
	}
	if f.From == nil || f.To == nil {
		httpx.Err(w, http.StatusBadRequest, "from dan to wajib untuk ekspor")
		return
	}
	if f.To.Sub(*f.From) > movementExportMaxDays*24*time.Hour {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "rentang ekspor maksimal 93 hari")
		return
	}
	rows, err := h.Repo.MovementLedgerSummaryAll(ctx, f.Window, f.LocationType, f.LocationID, r.URL.Query().Get("q"), movementExportMaxRows)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if len(rows) > movementExportMaxRows {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "ekspor melebihi 100000 baris; persempit filter")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="pergerakan-stok.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(movementSummaryCSVHeader)
	for _, row := range rows {
		_ = cw.Write(movementSummaryCSVRow(row))
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		// rows were all read first, so only a dead client reaches here: abort rather than end a short 200
		slog.Error("movement summary export: write failed", "err", err)
		panic(http.ErrAbortHandler)
	}
}
