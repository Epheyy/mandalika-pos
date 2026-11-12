package handlers

import (
	"net/http"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// GetBundleSettings returns the bundle price settings.
func (h *Handlers) GetBundleSettings(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.BundleSettings(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.BundleSettingsResponse{Data: v}, 200, nil
	})
}

// GetBundleCatalog returns the derived bundle catalog for every product (Backoffice view; the
// tablets get the outlet-scoped one inside the sync pull).
func (h *Handlers) GetBundleCatalog(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.BundleCatalog(r.Context(), read.Scope{CrossAll: true})
		if err != nil {
			return nil, 500, err
		}
		return api.BundleCatalogResponse{Data: v}, 200, nil
	})
}

// UpdateBundleSettings replaces the bundle prices (manage_products).
func (h *Handlers) UpdateBundleSettings(w http.ResponseWriter, r *http.Request) {
	var body api.BundleSettingsInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	in := write.BundleSettingsInput{}
	for _, s := range body.Standard {
		in.Standard = append(in.Standard, write.BundlePriceIn{Size: s.Size, Price: s.Price})
	}
	for _, lp := range body.LinePrices {
		in.LinePrices = append(in.LinePrices, write.BundleLinePriceIn{Line: lp.Line, Size: lp.Size, Price: lp.Price})
	}
	h.mutated(w, r, h.Write.UpdateBundleSettings(r.Context(), callerUserID(r), in))
}
