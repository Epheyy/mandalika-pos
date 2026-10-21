package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

func (h *Handlers) VariantRecipe(w http.ResponseWriter, r *http.Request) {
	rec, err := h.Repo.VariantRecipe(r.Context(), chi.URLParam(r, "variantId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err) // read.ErrNotFound → 404
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeResponse{Data: rec})
}

func (h *Handlers) RecipeVariantIDs(w http.ResponseWriter, r *http.Request) {
	ids, err := h.Repo.RecipeVariantIDs(r.Context(), chi.URLParam(r, "productId"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeVariantIdsResponse{VariantIds: ids})
}

func (h *Handlers) RecipeVersions(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RecipeVersions(r.Context(), chi.URLParam(r, "variantId"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeVersionListResponse{Data: rows})
}

func (h *Handlers) RecipeVersion(w http.ResponseWriter, r *http.Request) {
	rec, err := h.Repo.RecipeVersion(r.Context(), chi.URLParam(r, "variantId"), chi.URLParam(r, "versionId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RecipeResponse{Data: rec})
}

func (h *Handlers) SaveVariantRecipe(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.RecipeSave](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.SaveRecipe(r.Context(), c.userID, chi.URLParam(r, "variantId"), in)
	if errors.Is(err, write.ErrVersionConflict) {
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	h.created(w, r, id, err) // validation / inactive-add → 400; success → 201
}

func (h *Handlers) RestoreRecipeVersion(w http.ResponseWriter, r *http.Request) {
	// Body is optional; default to an empty struct when absent.
	var in write.RecipeRestore
	// An empty body is tolerated; a present-but-malformed one must not silently drop
	// expectedCurrentVersionId (that would bypass the version guard).
	if err := decodeOptionalBody(r, &in); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.RestoreRecipeVersion(r.Context(), c.userID,
		chi.URLParam(r, "variantId"), chi.URLParam(r, "versionId"), in.ExpectedCurrentVersionID)
	if errors.Is(err, write.ErrVersionConflict) {
		httpx.Err(w, http.StatusConflict, err.Error())
		return
	}
	h.created(w, r, id, err)
}
