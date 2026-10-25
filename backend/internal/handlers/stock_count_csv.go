package handlers

import (
	"encoding/csv"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// stockCountSheetColumns is the export header; the import reads the same names.
var stockCountSheetColumns = []string{"sku", "barcode", "product", "size", "expected_qty", "counted_qty"}

// ExportStockCount gives the sheet of an in-progress count for a scanner app: one row per
// line with the count-start quantity and an empty counted_qty. Read-only.
func (h *Handlers) ExportStockCount(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Err(w, http.StatusNotFound, "stock count tidak ditemukan")
		return
	}
	status, rows, err := h.Repo.StockCountSheet(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if status != "in_progress" {
		httpx.Err(w, http.StatusConflict, "CSV hanya tersedia untuk stock count yang sedang berjalan")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="stock-count-`+id+`.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(stockCountSheetColumns)
	for _, l := range rows {
		_ = cw.Write([]string{csvimport.GuardCell(l.SKU), csvimport.GuardCell(l.Barcode), csvimport.GuardCell(l.Product),
			csvimport.GuardCell(l.Size), strconv.Itoa(l.Expected), ""})
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		slog.Warn("stock count export: write failed", "err", err) // headers already sent
	}
}

// ImportStockCount stores scanner counts on an in-progress count: dry run (diff preview,
// nothing written) or commit (Idempotency-Key + the preview's hash and counters). It shares
// the import framework; the commit changes counted quantities only, never stock.
func (h *Handlers) ImportStockCount(w http.ResponseWriter, r *http.Request) {
	release, ok := h.beginImport(w, r)
	if !ok {
		return
	}
	defer release()
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Err(w, http.StatusNotFound, "stock count tidak ditemukan")
		return
	}
	body, ok := decodeImportBody[api.StockCountImportRequest](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	req := write.ImportRequest{Kind: csvimport.KindStockCount, CSV: body.Csv, DryRun: body.DryRun,
		TargetID: id, OutletID: c.outletID}
	if body.FileName != nil {
		req.FileName = *body.FileName
	}
	if !body.DryRun {
		key, ok := commitKey(w, r)
		if !ok {
			return
		}
		if body.FileSha256 == nil || *body.FileSha256 == "" || body.ExpectedSummary == nil {
			httpx.Err(w, http.StatusBadRequest, "fileSha256 dan expectedSummary dari pratinjau wajib untuk menerapkan impor")
			return
		}
		e := body.ExpectedSummary
		req.Key, req.FileSHA256 = key, *body.FileSha256
		req.ExpectedCount = &csvimport.StockCountSummary{Matched: e.Matched, Unknown: e.Unknown,
			Ambiguous: e.Ambiguous, NotOnCount: e.NotOnCount, Uncounted: e.Uncounted, Changed: e.Changed}
	}
	h.finishImport(w, r, req)
}
