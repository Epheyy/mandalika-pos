package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/coverage"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) CreateProduct(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Product](w, r)
	if !ok {
		return
	}
	seed := scope(r).OutletID
	if seed == read.NoOutlet {
		seed = "" // no active outlet: seed the primary outlet, as before
	}
	id, err := h.Write.CreateProduct(r.Context(), seed, p)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateProduct(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Product](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateProduct(r.Context(), chi.URLParam(r, "id"), p))
}

func (h *Handlers) DeleteProduct(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteProduct(r.Context(), chi.URLParam(r, "id")))
}

// filterOutletConfig keeps only the rows of outlets the caller covers, in the original order.
func filterOutletConfig(rows []api.OutletVariantConfig, cov coverage.Coverage) []api.OutletVariantConfig {
	out := make([]api.OutletVariantConfig, 0, len(rows))
	for _, row := range rows {
		if cov.Covers(row.OutletId.String()) {
			out = append(out, row)
		}
	}
	return out
}

// uncoveredOutlet returns the first outlet in the payload the caller does not cover.
func uncoveredOutlet(items []api.OutletConfigItemInput, cov coverage.Coverage) (string, bool) {
	for _, it := range items {
		if id := it.OutletId.String(); !cov.Covers(id) {
			return id, true
		}
	}
	return "", false
}

// GetProductOutletConfig: a covered-only manager sees only their own outlets' rows.
func (h *Handlers) GetProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.ProductOutletConfig(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	if !auth.CatalogueWide(r.Context()) {
		rows = filterOutletConfig(rows, auth.CoverageFrom(r.Context()))
	}
	writeJSON(w, http.StatusOK, api.OutletConfigResponse{Data: rows})
}

// PutProductOutletConfig: a covered-only manager may only name outlets they cover, and the
// size cleanup stays inside the outlets in the payload (the ones whose version is bumped).
func (h *Handlers) PutProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.OutletConfigInput](w, r)
	if !ok {
		return
	}
	coveredOnly := !auth.CatalogueWide(r.Context())
	if coveredOnly {
		if len(in.Items) == 0 {
			httpx.Err(w, http.StatusBadRequest, "Pilih minimal satu outlet.")
			return
		}
		if _, bad := uncoveredOutlet(in.Items, auth.CoverageFrom(r.Context())); bad {
			httpx.Err(w, http.StatusForbidden, "outlet not permitted")
			return
		}
	}
	h.mutated(w, r, h.Write.SetProductOutletConfig(r.Context(), chi.URLParam(r, "id"), in.Items, coveredOnly))
}

func (h *Handlers) CreateCategory(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Category](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCategory(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCategory(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Category](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCategory(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCategory(r.Context(), chi.URLParam(r, "id")))
}
