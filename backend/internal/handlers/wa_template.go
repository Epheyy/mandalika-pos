package handlers

import (
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/receiptlink"
	"github.com/mandalika/pos-backend/internal/write"
)

func writeRating(link read.ReceiptLinkInfo, f ratingForm, fast, sameNet bool) write.OrderRatingRow {
	return write.OrderRatingRow{
		OrderID: link.OrderID, LinkID: link.LinkID, OutletID: link.OutletID,
		SalesmanID: link.SalesmanID, SalesmanName: link.SalesmanName, BusinessDate: link.BusinessDate,
		Stars: f.stars, Tags: f.tags, Comment: f.comment, FlagFast: fast, FlagSameNetwork: sameNet,
	}
}

func waTemplateView(stored string) api.WaReceiptTemplate {
	tpl := stored
	if tpl == "" {
		tpl = receiptlink.DefaultTemplate
	}
	return api.WaReceiptTemplate{
		Template: tpl, IsDefault: stored == "", DefaultTemplate: receiptlink.DefaultTemplate,
		Placeholders: receiptlink.Placeholders,
	}
}

// GetWaReceiptTemplate is GET /settings/wa-receipt-template.
func (h *Handlers) GetWaReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	stored, err := h.Repo.WaReceiptTemplate(r.Context())
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.WaReceiptTemplateResponse{Data: waTemplateView(stored)})
}

// UpdateWaReceiptTemplate is PUT /settings/wa-receipt-template. An empty template (or one equal to
// the built-in default) resets to the default.
func (h *Handlers) UpdateWaReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	var in api.WaReceiptTemplateRequest
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Permintaan tidak valid.")
		return
	}
	tpl := strings.ReplaceAll(in.Template, "\r\n", "\n")
	var store *string
	if strings.TrimSpace(tpl) != "" && tpl != receiptlink.DefaultTemplate {
		if msg := receiptlink.Validate(tpl); msg != "" {
			httpx.Err(w, http.StatusBadRequest, msg)
			return
		}
		store = &tpl
	}
	if err := h.Write.SetWaReceiptTemplate(r.Context(), store); err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	stored := ""
	if store != nil {
		stored = *store
	}
	writeJSON(w, http.StatusOK, api.WaReceiptTemplateResponse{Data: waTemplateView(stored)})
}
