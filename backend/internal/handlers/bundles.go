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

// UpdateBundleSettings saves the bundle prices, group prices and outlet assignments
// (manage_products) and answers with the new revision.
func (h *Handlers) UpdateBundleSettings(w http.ResponseWriter, r *http.Request) {
	var body api.BundleSettingsInput
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	in := write.BundleSettingsInput{
		Revision: body.Revision,
		NewShape: body.Groups != nil || body.OutletGroups != nil,
	}
	for _, s := range body.Standard {
		in.Standard = append(in.Standard, write.BundlePriceIn{Size: s.Size, Price: s.Price})
	}
	for _, lp := range body.LinePrices {
		in.LinePrices = append(in.LinePrices, write.BundleLinePriceIn{Line: lp.Line, Size: lp.Size, Price: lp.Price})
	}
	if body.Groups != nil {
		for _, g := range *body.Groups {
			gp := write.BundleGroupPricesIn{GroupID: g.GroupId.String()}
			for _, s := range g.Standard {
				gp.Standard = append(gp.Standard, write.BundlePriceIn{Size: s.Size, Price: s.Price})
			}
			for _, lp := range g.LinePrices {
				gp.LinePrices = append(gp.LinePrices, write.BundleLinePriceIn{Line: lp.Line, Size: lp.Size, Price: lp.Price})
			}
			in.Groups = append(in.Groups, gp)
		}
	}
	if body.OutletGroups != nil {
		for _, og := range *body.OutletGroups {
			in.OutletGroups = append(in.OutletGroups, write.BundleOutletGroupIn{OutletID: og.OutletId.String(), GroupID: og.GroupId.String()})
		}
	}
	rev, err := h.Write.UpdateBundleSettings(r.Context(), callerUserID(r), in)
	if h.mutationFailed(w, r, err) {
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.BundleSettingsSaveResponse{Data: api.BundleSettingsSaved{Revision: rev}})
}
