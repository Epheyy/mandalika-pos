package handlers

import (
	"encoding/csv"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// skuMappingColumns is the export header (the import reads the same names).
var skuMappingColumns = []string{"variant_id", "product", "size", "sku", "has_stock", "barcode", "fg_code", "fg_slug", "erp_group_key"}

// ExportSkuMapping (admin) builds the one-time ERP SKU mapping sheet: one row per variant
// with empty fg_code/fg_slug/erp_group_key for the ERP owner to fill. Read-only.
func (h *Handlers) ExportSkuMapping(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.SkuMappingExport(r.Context())
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="sku-mapping.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(skuMappingColumns)
	for _, m := range rows {
		_ = cw.Write([]string{m.VariantID, csvimport.GuardCell(m.Product), csvimport.GuardCell(m.Size),
			csvimport.GuardCell(m.SKU), strconv.FormatBool(m.HasStock), csvimport.GuardCell(m.Barcode),
			csvimport.GuardCell(m.FGCode), csvimport.GuardCell(m.FGSlug), csvimport.GuardCell(m.ERPGroupKey)})
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		slog.Warn("sku mapping export: write failed", "err", err) // headers already sent
	}
}

// ImportSkuMapping (admin) shares the products/customers import flow: dry run, then
// commit with Idempotency-Key; all-or-nothing.
func (h *Handlers) ImportSkuMapping(w http.ResponseWriter, r *http.Request) {
	h.runImport(w, r, csvimport.KindSkuMapping)
}
