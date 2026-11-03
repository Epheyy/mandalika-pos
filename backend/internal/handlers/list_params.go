package handlers

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/bizday"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

// Backoffice list parameters (Fase D D2-API). Every one is optional: a request without them is
// answered exactly as before, so the tablet and the pickers that read the full lists are unchanged.

// maxSearchLen bounds a free-text search so a pasted blob cannot become a huge ILIKE pattern.
const maxSearchLen = 100

func searchParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > maxSearchLen {
		httpx.Err(w, http.StatusBadRequest, "q terlalu panjang")
		return "", false
	}
	return q, true
}

func enumParam(w http.ResponseWriter, r *http.Request, name string, allowed ...string) (string, bool) {
	v := r.URL.Query().Get(name)
	if v != "" && !slices.Contains(allowed, v) {
		httpx.Err(w, http.StatusBadRequest, name+" tidak valid")
		return "", false
	}
	return v, true
}

func uuidParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return "", true
	}
	if _, err := uuid.Parse(v); err != nil {
		httpx.Err(w, http.StatusBadRequest, name+" tidak valid")
		return "", false
	}
	return v, true
}

// productFilter reads the filters of GET /products; ok is false after a 400 was written.
func productFilter(w http.ResponseWriter, r *http.Request) (f read.ProductFilter, ok bool) {
	if f.Q, ok = searchParam(w, r); !ok {
		return f, false
	}
	if f.CategoryID, ok = uuidParam(w, r, "categoryId"); !ok {
		return f, false
	}
	if f.Stock, ok = enumParam(w, r, "stock", "low", "out"); !ok {
		return f, false
	}
	if f.Sort, ok = enumParam(w, r, "sort", "terbaru", "nama"); !ok {
		return f, false
	}
	if a := r.URL.Query().Get("active"); a != "" {
		b, err := strconv.ParseBool(a)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, "active harus true atau false")
			return f, false
		}
		f.Active = &b
	}
	return f, true
}

// promoListParams reads the paging and filters of GET /promotions and GET /discount-codes. paged is
// true when page or limit is present; without them the whole (filtered) list comes back, no meta.
func promoListParams(w http.ResponseWriter, r *http.Request) (f read.PromoListFilter, page, limit int, paged, ok bool) {
	if f.Q, ok = searchParam(w, r); !ok {
		return f, 0, 0, false, false
	}
	if f.Status, ok = enumParam(w, r, "status", read.PromoStatuses...); !ok {
		return f, 0, 0, false, false
	}
	f.Type = r.URL.Query().Get("type")
	q := r.URL.Query()
	if paged = q.Has("page") || q.Has("limit"); paged {
		page, limit = pageLimit(r)
	}
	return f, page, limit, paged, true
}

func promoMeta(paged bool, total, page, limit int) *api.Meta {
	if !paged {
		return nil
	}
	return meta(total, page, limit)
}

// ListGoodsReceipts is the Barang Masuk list, newest first. Warehouse receipts are not outlet-bound;
// an outlet receipt shows only inside the caller's outlet scope (everything for a cross-outlet scope).
func (h *Handlers) ListGoodsReceipts(w http.ResponseWriter, r *http.Request) {
	var f read.GoodsReceiptFilter
	var ok bool
	if f.LocationType, ok = enumParam(w, r, "locationType", "outlet", "warehouse"); !ok {
		return
	}
	if f.LocationID, ok = uuidParam(w, r, "locationId"); !ok {
		return
	}
	if f.LocationID != "" && f.LocationType == "" {
		httpx.Err(w, http.StatusBadRequest, "locationId memerlukan locationType")
		return
	}
	if f.Source, ok = enumParam(w, r, "source", "supply", "warranty"); !ok {
		return
	}
	if f.Q, ok = searchParam(w, r); !ok {
		return
	}
	if o := r.URL.Query().Get("outletId"); o != "" && o != "all" {
		if _, err := uuid.Parse(o); err != nil {
			httpx.Err(w, http.StatusBadRequest, "outletId tidak valid")
			return
		}
	}
	zone := bizday.Zone("")
	if f.LocationID != "" {
		z, exists, err := h.Repo.LocationZone(r.Context(), f.LocationType, f.LocationID)
		if err != nil {
			writeErr(w, r, http.StatusInternalServerError, err)
			return
		}
		if !exists {
			httpx.Err(w, http.StatusNotFound, "lokasi tidak ditemukan")
			return
		}
		zone = z
	}
	var err error
	q := r.URL.Query()
	if f.From, err = parseMovementBound(q.Get("dari"), zone, false); err != nil {
		httpx.Err(w, http.StatusBadRequest, "dari tidak valid")
		return
	}
	if f.To, err = parseMovementBound(q.Get("sampai"), zone, true); err != nil {
		httpx.Err(w, http.StatusBadRequest, "sampai tidak valid")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.GoodsReceipts(r.Context(), scope(r), f, p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.GoodsReceiptListResponse{Data: rows, Meta: *meta(total, p, l)})
}

// approvalFilter reads outletId and kind of GET /inventory/approvals. outletId is also the admin's
// scope switch (scope()), so "all" means no narrowing here.
func approvalFilter(w http.ResponseWriter, r *http.Request) (f read.ApprovalFilter, ok bool) {
	if r.URL.Query().Get("outletId") != "all" {
		if f.OutletID, ok = uuidParam(w, r, "outletId"); !ok {
			return f, false
		}
	}
	f.Kind, ok = enumParam(w, r, "kind", "adjustment", "count")
	return f, ok
}
