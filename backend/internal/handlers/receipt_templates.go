package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/receipttpl"
	"github.com/mandalika/pos-backend/internal/write"
)

// templateRefusal answers a template rule break (422) or conflict (409) with its message and reports
// whether it did. Everything else goes through the shared mapper.
func templateRefusal(w http.ResponseWriter, err error) bool {
	var ve *receipttpl.Error
	if errors.As(err, &ve) {
		httpx.Err(w, http.StatusUnprocessableEntity, ve.Message)
		return true
	}
	var ce *write.ReceiptTemplateConflict
	if errors.As(err, &ce) {
		httpx.Err(w, http.StatusConflict, ce.Msg)
		return true
	}
	return false
}

func templateIn(b api.ReceiptTemplateInput) write.ReceiptTemplateIn {
	in := write.ReceiptTemplateIn{Name: b.Name, PaperWidth: int(b.PaperWidth), Blocks: b.Blocks}
	if b.IsDefault != nil {
		in.IsDefault = *b.IsDefault
	}
	return in
}

// ListReceiptTemplates returns every receipt template with the outlets that print it (manage_settings).
func (h *Handlers) ListReceiptTemplates(w http.ResponseWriter, r *http.Request) {
	list, err := h.Repo.ReceiptTemplates(r.Context())
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ReceiptTemplateListResponse{Data: list})
}

// CreateReceiptTemplate stores a new template (manage_settings).
func (h *Handlers) CreateReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	var body api.ReceiptTemplateInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	id, err := h.Write.CreateReceiptTemplate(r.Context(), callerUserID(r), templateIn(body))
	if err != nil {
		if !templateRefusal(w, err) {
			writeErr(w, r, http.StatusBadRequest, err)
		}
		return
	}
	h.invalidate(r)
	h.writeTemplate(w, r, http.StatusCreated, id)
}

// UpdateReceiptTemplate saves a template; the body's version must be the one the editor loaded.
func (h *Handlers) UpdateReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	var body api.ReceiptTemplateInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	if body.Version == nil {
		httpx.Err(w, http.StatusBadRequest, "version wajib diisi")
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.Write.UpdateReceiptTemplate(r.Context(), callerUserID(r), id, templateIn(body), *body.Version); err != nil {
		if !templateRefusal(w, err) {
			h.mutated(w, r, err)
		}
		return
	}
	h.invalidate(r)
	h.writeTemplate(w, r, http.StatusOK, id)
}

// DeleteReceiptTemplate removes an unused, non-default template.
func (h *Handlers) DeleteReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	if err := h.Write.DeleteReceiptTemplate(r.Context(), chi.URLParam(r, "id")); err != nil {
		if !templateRefusal(w, err) {
			h.mutated(w, r, err)
		}
		return
	}
	h.mutated(w, r, nil)
}

// AssignReceiptTemplate moves outlets onto a template, or back to the default.
func (h *Handlers) AssignReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	var body api.ReceiptTemplateAssignInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	var tid *string
	if body.TemplateId != nil {
		s := body.TemplateId.String()
		tid = &s
	}
	ids := make([]string, 0, len(body.OutletIds))
	for _, o := range body.OutletIds {
		ids = append(ids, o.String())
	}
	if err := h.Write.AssignReceiptTemplate(r.Context(), tid, ids); err != nil {
		if !templateRefusal(w, err) {
			h.mutated(w, r, err)
		}
		return
	}
	h.mutated(w, r, nil)
}

func (h *Handlers) writeTemplate(w http.ResponseWriter, r *http.Request, status int, id string) {
	t, err := h.Repo.ReceiptTemplate(r.Context(), id)
	if err != nil {
		if errors.Is(err, read.ErrNotFound) {
			httpx.Err(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, status, api.ReceiptTemplateResponse{Data: t})
}
