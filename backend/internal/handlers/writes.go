package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// caller resolves the authenticated identity. Outlet/user never come from the
// request body (plan §2a, §5).
type callerID struct {
	outletID, userID, name string
}

func (h *Handlers) caller(r *http.Request) (callerID, error) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
	c := callerID{outletID: outlet, userID: uid}
	if u, err := h.Store.ByID(r.Context(), uid); err == nil {
		c.name = u.DisplayName
		if c.outletID == "" {
			c.outletID = u.OutletID
		}
	}
	return c, nil
}

func decodeWrite[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := httpx.DecodeLoose(r, &v); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return v, false
	}
	return v, true
}

func (h *Handlers) created(w http.ResponseWriter, r *http.Request, id string, err error) {
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]string{"id": id}})
}

func (h *Handlers) mutated(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Reference CRUD ────────────────────────────────────────

func (h *Handlers) CreateProduct(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Product](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateProduct(r.Context(), scope(r).OutletID, p)
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

func (h *Handlers) GetProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.ProductOutletConfig(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OutletConfigResponse{Data: rows})
}

func (h *Handlers) PutProductOutletConfig(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.OutletConfigInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetProductOutletConfig(r.Context(), chi.URLParam(r, "id"), in.Items))
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

func (h *Handlers) CreateCustomer(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Customer](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCustomer(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCustomer(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.Customer](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCustomer(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCustomer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCustomer(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) CreatePromotion(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Promotion](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreatePromotion(r.Context(), p)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdatePromotion(w http.ResponseWriter, r *http.Request) {
	p, ok := decodeWrite[write.Promotion](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdatePromotion(r.Context(), chi.URLParam(r, "id"), p))
}

func (h *Handlers) DeletePromotion(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeletePromotion(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) CreateDiscountCode(w http.ResponseWriter, r *http.Request) {
	d, ok := decodeWrite[write.DiscountCode](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateDiscountCode(r.Context(), d)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateDiscountCode(w http.ResponseWriter, r *http.Request) {
	d, ok := decodeWrite[write.DiscountCode](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateDiscountCode(r.Context(), chi.URLParam(r, "id"), d))
}

func (h *Handlers) DeleteDiscountCode(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteDiscountCode(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) CreateOutlet(w http.ResponseWriter, r *http.Request) {
	o, ok := decodeWrite[write.Outlet](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateOutlet(r.Context(), o)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateOutlet(w http.ResponseWriter, r *http.Request) {
	o, ok := decodeWrite[write.Outlet](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateOutlet(r.Context(), chi.URLParam(r, "id"), o))
}

// ── Warehouses (not POS-synced) ───────────────────────────

func (h *Handlers) Warehouses(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Warehouses(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateWarehouse(r.Context(), wh)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateWarehouse(w http.ResponseWriter, r *http.Request) {
	wh, ok := decodeWrite[write.Warehouse](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateWarehouse(r.Context(), chi.URLParam(r, "id"), wh))
}

func (h *Handlers) DeleteWarehouse(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteWarehouse(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) WarehouseStock(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.WarehouseStock(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	g, ok := decodeWrite[write.GoodsReceipt](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CreateGoodsReceipt(r.Context(), chi.URLParam(r, "id"), c.userID, g))
}

func (h *Handlers) AdjustWarehouseStock(w http.ResponseWriter, r *http.Request) {
	a, ok := decodeWrite[write.WarehouseAdjust](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.AdjustWarehouseStock(r.Context(), chi.URLParam(r, "id"), c.userID, a))
}

func (h *Handlers) UpdateAppSettings(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := httpx.DecodeLoose(r, &raw); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	h.mutated(w, r, h.Write.UpdateAppSettings(r.Context(), raw))
}

func (h *Handlers) UpdateLoyaltySettings(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := httpx.DecodeLoose(r, &raw); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	h.mutated(w, r, h.Write.UpdateLoyaltySettings(r.Context(), raw))
}

// ── Orders / sales (server-authoritative tx) ──────────────

type createOrderBody struct {
	OrderUuid         string              `json:"orderUuid"`
	DeviceID          string              `json:"deviceId"`
	SalesmanID        string              `json:"salesmanId"`
	SalesmanName      string              `json:"salesmanName"`
	CustomerID        string              `json:"customerId"`
	CustomerName      string              `json:"customerName"`
	Items             []service.OrderItem `json:"items"`
	PaymentMethod     string              `json:"paymentMethod"`
	AmountPaid        float64             `json:"amountPaid"`
	DiscountType      string              `json:"discountType"`
	DiscountValue     float64             `json:"discountValue"`
	SurchargeVal      float64             `json:"surchargeValue"`
	SurchargeKind     string              `json:"surchargeType"`
	DiscountCode      string              `json:"discountCode"`
	PromotionID       string              `json:"promotionId"`
	DiscountLabel     string              `json:"discountLabel"`
	DiscountBreakdown json.RawMessage     `json:"discountBreakdown"`
	PointsRedeemed    int                 `json:"pointsRedeemed"`
	Notes             string              `json:"notes"`
	ShiftID           string              `json:"shiftId"`
}

func (h *Handlers) CreateOrder(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[createOrderBody](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	idem := r.Header.Get("Idempotency-Key")
	if idem == "" {
		httpx.Err(w, http.StatusBadRequest, "Idempotency-Key header required")
		return
	}
	// Redis fast-path: a known key returns the canonical order immediately.
	if h.Cache != nil {
		if oid, hit := h.Cache.Get(r.Context(), "idem:"+idem); hit {
			h.returnOrder(w, r, oid)
			return
		}
	}
	in := service.CreateOrderInput{
		IdempotencyKey: idem, OrderUUID: body.OrderUuid, DeviceID: body.DeviceID,
		OutletID: c.outletID, CashierID: c.userID, CashierName: c.name,
		SalesmanID: body.SalesmanID, SalesmanName: body.SalesmanName,
		CustomerID: body.CustomerID, CustomerName: body.CustomerName,
		Items: body.Items, PaymentMethod: body.PaymentMethod,
		AmountPaid: body.AmountPaid, ManualKind: service.DiscountKind(body.DiscountType),
		ManualValue: body.DiscountValue, Surcharge: body.SurchargeVal,
		SurchargeKind: service.DiscountKind(body.SurchargeKind),
		DiscountCode:  body.DiscountCode, PromotionID: body.PromotionID,
		DiscountLabel:     body.DiscountLabel,
		DiscountBreakdown: body.DiscountBreakdown,
		PointsRedeemed:    body.PointsRedeemed,
		Notes:             body.Notes, ShiftID: body.ShiftID, Offline: false,
	}
	id, _, _, err := h.OrderSvc.CreateOrder(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if h.Cache != nil {
		h.Cache.Set(r.Context(), "idem:"+idem, id, 24*60*60*1e9)
	}
	h.invalidate(r)
	h.returnOrder(w, r, id)
}

func (h *Handlers) returnOrder(w http.ResponseWriter, r *http.Request, id string) {
	o, err := h.Repo.Order(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o})
}

func (h *Handlers) RefundOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason string `json:"reason"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil || body.Reason == "" {
		httpx.Err(w, http.StatusBadRequest, "refund reason required")
		return
	}
	c, _ := h.caller(r)
	if err := h.OrderSvc.Refund(r.Context(), c.outletID, chi.URLParam(r, "id"), body.Reason); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	h.returnOrder(w, r, chi.URLParam(r, "id"))
}

func (h *Handlers) OpenShift(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OutletName   string  `json:"outletName"`
		StartingCash float64 `json:"startingCash"`
	}
	_ = httpx.DecodeLoose(r, &body)
	c, _ := h.caller(r)
	id, err := h.OrderSvc.OpenShift(r.Context(), service.OpenShiftInput{
		OutletID: c.outletID, OutletName: body.OutletName,
		CashierID: c.userID, CashierName: c.name, StartingCash: body.StartingCash,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	v, _ := h.Repo.Shift(r.Context(), scope(r), id)
	writeJSON(w, http.StatusCreated, map[string]any{"data": nullableShift(v)})
}

func (h *Handlers) CloseShift(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClosingCash     float64            `json:"closingCash"`
		CountedByMethod map[string]float64 `json:"countedByMethod"`
	}
	_ = httpx.DecodeLoose(r, &body)
	c, _ := h.caller(r)
	if err := h.OrderSvc.CloseShift(r.Context(), c.outletID, chi.URLParam(r, "id"), body.ClosingCash, body.CountedByMethod); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	v, _ := h.Repo.Shift(r.Context(), scope(r), chi.URLParam(r, "id"))
	writeJSON(w, http.StatusOK, map[string]any{"data": nullableShift(v)})
}

// CreateErrorLogs records a batch of client errors (sync/runtime/print). Outlet
// and user come from the JWT; the rest from the body. Best-effort.
func (h *Handlers) CreateErrorLogs(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []struct {
			DeviceID        string          `json:"deviceId"`
			OutletName      string          `json:"outletName"`
			Source          string          `json:"source"`
			Kind            string          `json:"kind"`
			Action          string          `json:"action"`
			Message         string          `json:"message"`
			Payload         json.RawMessage `json:"payload"`
			Breadcrumbs     json.RawMessage `json:"breadcrumbs"`
			AppVersion      string          `json:"appVersion"`
			ClientCreatedAt *time.Time      `json:"clientCreatedAt"`
		} `json:"items"`
	}
	_ = httpx.DecodeLoose(r, &body)
	c, _ := h.caller(r)
	logs := make([]write.ErrorLog, 0, len(body.Items))
	for _, it := range body.Items {
		if it.Message == "" {
			continue
		}
		src := it.Source
		if src == "" {
			src = "runtime"
		}
		logs = append(logs, write.ErrorLog{
			OutletID: c.outletID, OutletName: it.OutletName, DeviceID: it.DeviceID,
			UserID: c.userID, UserName: c.name, Source: src, Kind: it.Kind,
			Action: it.Action, Message: it.Message, Payload: it.Payload,
			Breadcrumbs: it.Breadcrumbs, AppVersion: it.AppVersion,
			ClientCreatedAt: it.ClientCreatedAt,
		})
	}
	if err := h.Write.InsertErrorLogs(r.Context(), logs); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) CreateCashFlow(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ShiftID     string  `json:"shiftId"`
		Type        string  `json:"type"`
		Amount      float64 `json:"amount"`
		Description string  `json:"description"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	id, err := h.OrderSvc.AddCashFlow(r.Context(), service.CashFlowInput{
		OutletID: c.outletID, ShiftID: body.ShiftID, Type: body.Type,
		Amount: body.Amount, Description: body.Description,
		CashierID: c.userID, CashierName: c.name,
	})
	h.created(w, r, id, err)
}

// ── Custom roles (admin) ──────────────────────────────────

func (h *Handlers) CreateCustomRole(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.CustomRole](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateCustomRole(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateCustomRole(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.CustomRole](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateCustomRole(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteCustomRole(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteCustomRole(r.Context(), chi.URLParam(r, "id")))
}

// ── Stock counts (outlet-scoped) ──────────────────────────

func (h *Handlers) CreateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	outletID := c.outletID
	if body.WarehouseID != "" {
		outletID = "" // warehouse count: location is the warehouse, not an outlet
	} else if outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	id, err := h.Write.CreateStockCount(r.Context(), outletID, c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateStockCount(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.StockCountUpdate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — the repo (scopeCount) authorizes: outlet counts must match
	// the caller's outlet; warehouse counts are permission-gated by the route.
	h.mutated(w, r, h.Write.UpdateStockCount(r.Context(),
		chi.URLParam(r, "id"), c.outletID, body))
}

func (h *Handlers) CompleteStockCount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []write.StockCountItem `json:"items"`
	}
	_ = httpx.DecodeLoose(r, &body)
	c, _ := h.caller(r)
	// No outlet guard — repo authorizes (see UpdateStockCount).
	id := chi.URLParam(r, "id")
	if err := h.Write.CompleteStockCount(r.Context(), id, c.outletID, body.Items); err != nil {
		if errors.Is(err, write.ErrNotFound) {
			httpx.Err(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	v, err := h.Repo.StockCount(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// ── Sync wall + outbox ────────────────────────────────────

func (h *Handlers) SyncVersion(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	v, err := h.Sync.Version(r.Context(), c.outletID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *Handlers) SyncPull(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	b, err := h.Sync.Pull(r.Context(), scope(r), c.outletID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": b})
}

func (h *Handlers) SyncBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []syncpkg.BatchItem `json:"items"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	res, err := h.Sync.ProcessBatch(r.Context(), syncpkg.Caller{
		OutletID: c.outletID, UserID: c.userID, DisplayName: c.name,
	}, body.Items)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

func (h *Handlers) SignUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Folder string `json:"folder"`
	}
	_ = httpx.DecodeLoose(r, &body)
	sig, err := h.Signer.Sign(body.Folder)
	if err != nil {
		httpx.Err(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": sig})
}
