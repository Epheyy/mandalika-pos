// Package handlers wires the Phase B read endpoints (+ users CRUD) onto the
// existing chi router. Responses use generated api.* DTOs so the wire shape
// always matches api/openapi.yaml. Reads are Redis cache-aside (degradable).
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
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
	// importSlots bounds concurrent CSV imports per process (a 50k-row preview holds several copies in memory).
	importSlots chan struct{}
	// receipts overrides the PostgreSQL receipt runner of keyed backoffice writes (tests only).
	receipts service.ReceiptRunner
	// erpPull runs the ERP catalog pull; nil when the integration is disabled (endpoints answer 503).
	erpPull ErpCatalogRunner
	// lastErrorLogSweep (unix nanos) throttles the error_logs retention sweep triggered by POST /error-logs.
	lastErrorLogSweep atomic.Int64
}

func New(repo *read.Repo, c *cache.Cache, store *auth.Store, wr *write.Repo,
	os *service.OrderService, sy *syncpkg.Engine, signer *uploads.Signer) *Handlers {
	h := &Handlers{Repo: repo, Cache: c, Store: store, Write: wr,
		OrderSvc: os, Sync: sy, Signer: signer,
		importSlots: make(chan struct{}, maxConcurrentImports)}
	// cmd/server sweeps error_logs at startup; the first POST-triggered sweep is an interval later.
	h.lastErrorLogSweep.Store(time.Now().UnixNano())
	return h
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
		writeErr(w, r, status, err)
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
		rows, total, err := h.Repo.Products(r.Context(), scope(r), p, l)
		if err != nil {
			return nil, 500, err
		}
		return api.ProductListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

func (h *Handlers) Product(w http.ResponseWriter, r *http.Request) {
	h.cached(w, r, ckey(r), func() (any, int, error) {
		v, err := h.Repo.Product(r.Context(), scope(r), chi.URLParam(r, "id"))
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

// discountCodesCacheKey splits the cache by the one thing that changes the body: whether
// the caller may see which customer a code is assigned to (manage_promotions, A30).
func discountCodesCacheKey(r *http.Request) string {
	if auth.HasPermission(r.Context(), "manage_promotions") {
		return ckey(r) + ":p=1"
	}
	return ckey(r) + ":p=0"
}

func (h *Handlers) DiscountCodes(w http.ResponseWriter, r *http.Request) {
	showNames := auth.HasPermission(r.Context(), "manage_promotions")
	h.cached(w, r, discountCodesCacheKey(r), func() (any, int, error) {
		rows, _, err := h.Repo.DiscountCodes(r.Context())
		if err != nil {
			return nil, 500, err
		}
		if !showNames {
			rows = read.WithoutCustomerNames(rows)
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
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		sort := r.URL.Query().Get("sort")
		tagId := r.URL.Query().Get("tagId")
		segmentId := r.URL.Query().Get("segmentId")
		rows, total, err := h.Repo.Customers(r.Context(), p, l, q, sort, tagId, segmentId)
		if err != nil {
			return nil, 500, err
		}
		return api.CustomerListResponse{Data: rows, Meta: meta(total, p, l)}, 200, nil
	})
}

// CustomersByPhone is the pre-create duplicate check. It is intentionally
// NOT cached: serving a stale "no match" from the read cache could let a
// duplicate slip past the warning. It also reads phone directly, so we guard
// against an empty value here (bypasses the generated OpenAPI validation).
func (h *Handlers) CustomersByPhone(w http.ResponseWriter, r *http.Request) {
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	if phone == "" {
		httpx.Err(w, http.StatusBadRequest, "phone wajib diisi")
		return
	}
	rows, err := h.Repo.CustomerByPhone(r.Context(), phone)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.CustomerListResponse{Data: rows, Meta: meta(len(rows), 1, len(rows))})
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

// ordersCacheKey splits the cached order list by customer scope, because q reaches
// customer names only for callers who may browse customers (A30).
func ordersCacheKey(r *http.Request) string {
	if customerScope(r) == CustomerAll {
		return ckey(r) + ":cs=1"
	}
	return ckey(r) + ":cs=0"
}

func (h *Handlers) Orders(w http.ResponseWriter, r *http.Request) {
	f, ok := ordersFilter(w, r)
	if !ok {
		return
	}
	h.cached(w, r, ordersCacheKey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Orders(r.Context(), f, p, l)
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
	dateFrom, dateTo := r.URL.Query().Get("dateFrom"), r.URL.Query().Get("dateTo")
	if !dayRange(w, dateFrom, dateTo) {
		return
	}
	h.cached(w, r, ckey(r), func() (any, int, error) {
		p, l := pageLimit(r)
		rows, total, err := h.Repo.Shifts(r.Context(), scope(r), dateFrom, dateTo, p, l)
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
		writeErr(w, r, http.StatusInternalServerError, err)
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
		writeErr(w, r, 500, err)
		return
	}
	resp.Data = nullableShift(v)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) Shift(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.Shift(r.Context(), scope(r), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, r, 500, err)
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
	f, ok := summaryFilter(w, r)
	if !ok {
		return
	}
	h.cached(w, r, ordersCacheKey(r), func() (any, int, error) {
		v, err := h.Repo.ReportSummary(r.Context(), f)
		if err != nil {
			return nil, 500, err
		}
		return api.ReportSummaryResponse{Data: v}, 200, nil
	})
}

// PromoRewardGrants returns a grouped, paginated report of promo reward
// grants (BXGY/free-item giveaways) for completed orders, filterable by date
// range, outlet, promotion, and product. Gated on view_reports.
func (h *Handlers) PromoRewardGrants(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	if !dayRange(w, q.Get("dateFrom"), q.Get("dateTo")) {
		return
	}
	sc := scope(r)
	f := read.GrantReportFilters{
		DateFrom:    q.Get("dateFrom"),
		DateTo:      q.Get("dateTo"),
		OutletID:    sc.OutletID, // scope-clamped: non-admin→their outlet, admin→?outletId/all/header
		PromotionID: q.Get("promotionId"),
		ProductID:   q.Get("productId"),
	}
	summary, rows, total, err := h.Repo.PromoRewardGrantReport(r.Context(), f, p, l)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.PromoRewardGrantReport{
		Summary: summary,
		Data:    rows,
		Meta:    *meta(total, p, l),
	})
}

// DiscountCodeReport returns a paginated per-code discount-code redemption
// report (value attributed from orders.discount_breakdown), filterable by
// date range and outlet. Gated on view_reports.
func (h *Handlers) DiscountCodeReport(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	if !dayRange(w, q.Get("dateFrom"), q.Get("dateTo")) {
		return
	}
	sc := scope(r)
	f := read.CodeReportFilters{
		DateFrom: q.Get("dateFrom"),
		DateTo:   q.Get("dateTo"),
		OutletID: sc.OutletID, // scope-clamped (non-admin → their outlet; admin → ?outletId/all/header); "" = all
	}
	summary, rows, total, err := h.Repo.DiscountCodeReport(r.Context(), f, p, l)
	if err != nil {
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.DiscountCodeReport{Summary: summary, Data: rows, Meta: *meta(total, p, l)})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
