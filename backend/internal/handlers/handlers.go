// Package handlers wires the Phase B read endpoints (+ users CRUD) onto the
// existing chi router. Responses use generated api.* DTOs so the wire shape
// always matches api/openapi.yaml. Reads are Redis cache-aside (degradable).
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/uploads"
	"github.com/mandalika/pos-backend/internal/write"
)

const readTTL = 15 * time.Second

type Handlers struct {
	Repo     *read.Repo
	Cache    *cache.Cache
	Store    *auth.Store
	Write    *write.Repo
	OrderSvc *service.OrderService
	Sync     *syncpkg.Engine
	Signer   *uploads.Signer
}

func New(repo *read.Repo, c *cache.Cache, store *auth.Store, wr *write.Repo,
	os *service.OrderService, sy *syncpkg.Engine, signer *uploads.Signer) *Handlers {
	return &Handlers{Repo: repo, Cache: c, Store: store, Write: wr,
		OrderSvc: os, Sync: sy, Signer: signer}
}

// invalidate drops the whole read cache (degradable, coarse). Called after any
// write so the next GET reflects the mutation.
func (h *Handlers) invalidate(r *http.Request) {
	if h.Cache != nil {
		h.Cache.DelByPrefix(r.Context(), "rd:")
	}
}

// scope resolves the outlet boundary from the validated token context plus an
// admin-only ?outletId override ("all" = cross-outlet).
func scope(r *http.Request) read.Scope {
	role, _ := r.Context().Value(auth.CtxRole).(string)
	outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
	if role == "admin" {
		switch q := r.URL.Query().Get("outletId"); {
		case q == "all":
			return read.Scope{CrossAll: true}
		case q != "":
			return read.Scope{OutletID: q}
		case outlet == "":
			return read.Scope{CrossAll: true}
		}
	}
	return read.Scope{OutletID: outlet}
}

func pageLimit(r *http.Request) (int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	return page, limit
}

func meta(total, page, limit int) *api.Meta {
	return &api.Meta{Total: total, Page: page, Limit: limit}
}

// cached serves a GET via Redis cache-aside; build() produces the response
// struct on miss. Cache failures degrade to a direct build.
func (h *Handlers) cached(w http.ResponseWriter, r *http.Request, key string, build func() (any, int, error)) {
	ctx := r.Context()
	if h.Cache != nil {
		if v, ok := h.Cache.Get(ctx, key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Cache", "HIT")
			_, _ = w.Write([]byte(v))
			return
		}
	}
	body, status, err := build()
	if err != nil {
		writeErr(w, status, err)
		return
	}
	raw, _ := json.Marshal(body)
	if h.Cache != nil {
		h.Cache.Set(ctx, key, string(raw), readTTL)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache", "MISS")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	if errors.Is(err, read.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if status == 0 {
		status = http.StatusInternalServerError
	}
	httpx.Err(w, status, err.Error())
}

func ckey(r *http.Request) string {
	sc := scope(r)
	o := sc.OutletID
	if sc.CrossAll {
		o = "all"
	}
	return "rd:" + r.Method + ":" + r.URL.Path + ":" + o + ":" + r.URL.RawQuery
}

// ── Catalog / reference (global) ──────────────────────────

func (h *Handlers) Products(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Products(r.Context(), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.ProductListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) Product(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.Product(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			return nil, 500, err
		}
		return api.ProductResponse{Data: v}, 200, nil
	})
}

func (h *Handlers) Categories(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.Categories(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.CategoryListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) Bundles(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.Bundles(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.BundleListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) Outlets(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.Outlets(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.OutletListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) Promotions(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.Promotions(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.PromotionListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) DiscountCodes(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.DiscountCodes(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.DiscountCodeListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) LoyaltyConditions(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.LoyaltyConditions(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.LoyaltyConditionListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) CustomRoles(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		rows, _, err := h.Repo.CustomRoles(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.CustomRoleListResponse{Data: rows}, 200, nil
	})
}

func (h *Handlers) AppSettings(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.AppSettings(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.AppSettingsResponse{Data: v}, 200, nil
	})
}

func (h *Handlers) LoyaltySettings(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.LoyaltySettings(r.Context())
		if err != nil {
			return nil, 500, err
		}
		return api.LoyaltySettingsResponse{Data: v}, 200, nil
	})
}

func (h *Handlers) Customers(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Customers(r.Context(), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) Customer(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.Customer(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerResponse{Data: v}, 200, nil
	})
}

// ── Sales (outlet-scoped) ─────────────────────────────────

func (h *Handlers) Orders(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		q := r.URL.Query()
		rows, total, err := h.Repo.Orders(r.Context(), scope(r),
			q.Get("shiftId"), q.Get("customerId"), q.Get("from"), q.Get("to"),
			q.Get("q"), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.OrderListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) Order(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.Order(r.Context(), scope(r), chi.URLParam(r, "id"))
		if err != nil {
			return nil, 500, err
		}
		return api.OrderResponse{Data: v}, 200, nil
	})
}

func (h *Handlers) Shifts(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Shifts(r.Context(), scope(r), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.ShiftListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

// ErrorLogs lists captured errors (admin). Not cached — must be fresh.
func (h *Handlers) ErrorLogs(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	rows, total, err := h.Repo.ErrorLogs(r.Context(),
		q.Get("outletId"), q.Get("source"), q.Get("from"), q.Get("to"), p, l)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ErrorLogListResponse{Data: rows, Meta: meta(total, p, l)})
}

func (h *Handlers) CurrentShift(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.CurrentShift(r.Context(), scope(r))
	resp := api.ShiftResponse{}
	if errors.Is(err, read.ErrNotFound) {
		resp.Data = nullableShiftNull()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	resp.Data = nullableShift(v)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) Shift(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.Shift(r.Context(), scope(r), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ShiftResponse{Data: nullableShift(v)})
}

func (h *Handlers) StockCounts(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.StockCounts(r.Context(), scope(r), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.StockCountListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) StockCount(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.StockCount(r.Context(), scope(r), chi.URLParam(r, "id"))
		if err != nil {
			return nil, 500, err
		}
		return api.StockCountResponse{Data: v}, 200, nil
	})
}

func (h *Handlers) CashFlows(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.CashFlows(r.Context(), scope(r),
			r.URL.Query().Get("shiftId"), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.CashFlowListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) ReportSummary(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := now.AddDate(0, 0, -30)
	to := now
	if v := r.URL.Query().Get("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		}
	}
	h.cached(w, r, ckey(r)+":"+from.Format(time.RFC3339)+":"+to.Format(time.RFC3339),
		func() (any, int, error) {
			v, err := h.Repo.ReportSummary(r.Context(), scope(r), from, to)
			if err != nil {
				return nil, 500, err
			}
			return api.ReportSummaryResponse{Data: v}, 200, nil
		})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
