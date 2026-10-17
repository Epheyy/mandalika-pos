package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// caller resolves the authenticated identity. Outlet/user never come from the
// request body (plan §2a, §5).
type callerID struct {
	outletID, userID, name string
	// role and homeOutletID are read from the users row, never from the request (A04).
	role, homeOutletID string
}

func (h *Handlers) caller(r *http.Request) (callerID, error) {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
	c := callerID{outletID: outlet, userID: uid}
	if u, err := h.Store.ByID(r.Context(), uid); err == nil {
		c.name = u.DisplayName
		c.role, c.homeOutletID = u.Role, u.OutletID
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
	if errors.Is(err, write.ErrBusy) {
		// Lock conflict/deadlock: nothing was applied, safe to retry. Clean message only.
		httpx.Err(w, http.StatusConflict, err.Error())
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

// CreateDiscountCodeBatch generates a batch of unique discount codes sharing
// one set of settings (write.CreateDiscountCodeBatch), then re-fetches the
// created rows via the read repo (DiscountCodesByIDs) rather than hand-assembling
// api.DiscountCode — its nullable.Nullable wrappers are painful/error-prone to
// build by hand and the read repo already serializes them correctly.
func (h *Handlers) CreateDiscountCodeBatch(w http.ResponseWriter, r *http.Request) {
	b, ok := decodeWrite[write.DiscountCodeBatch](w, r)
	if !ok {
		return
	}
	created, err := h.Write.CreateDiscountCodeBatch(r.Context(), b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err) // validation/generation error → 400 + message
		return
	}
	ids := make([]string, len(created))
	for i, c := range created {
		ids[i] = c.ID
	}
	rows, _, err := h.Repo.DiscountCodesByIDs(r.Context(), ids)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.DiscountCodeListResponse{Data: rows})
}

func (h *Handlers) CreateLoyaltyCondition(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.LoyaltyCondition](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateLoyaltyCondition(r.Context(), c)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateLoyaltyCondition(w http.ResponseWriter, r *http.Request) {
	c, ok := decodeWrite[write.LoyaltyCondition](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateLoyaltyCondition(r.Context(), chi.URLParam(r, "id"), c))
}

func (h *Handlers) DeleteLoyaltyCondition(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteLoyaltyCondition(r.Context(), chi.URLParam(r, "id")))
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

// ── Transfers (Backoffice; mesh warehouse/outlet) ─────────

func (h *Handlers) Transfers(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	status := q.Get("status")
	from := q.Get("from")
	to := q.Get("to")
	locKind := q.Get("locKind")
	locID := q.Get("locID")
	if locKind != "" && locKind != "outlet" && locKind != "warehouse" {
		httpx.Err(w, http.StatusBadRequest, "locKind harus outlet atau warehouse")
		return
	}
	rows, total, err := h.Repo.Transfers(r.Context(), status, from, to, locKind, locID, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TransferListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) Transfer(w http.ResponseWriter, r *http.Request) {
	v, err := h.Repo.Transfer(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 0, err) // writeErr maps read.ErrNotFound → 404
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *Handlers) TransferLocationStock(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	id := r.URL.Query().Get("id")
	if kind != "warehouse" && kind != "outlet" {
		httpx.Err(w, http.StatusBadRequest, "kind harus 'warehouse' atau 'outlet'")
		return
	}
	if id == "" {
		httpx.Err(w, http.StatusBadRequest, "id wajib")
		return
	}
	rows, err := h.Repo.LocationStock(r.Context(), kind, id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateTransfer(r.Context(), c.userID, body)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferCreate](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTransferDraft(r.Context(), chi.URLParam(r, "id"), body))
}

func (h *Handlers) SendTransfer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.SendTransfer(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) ReceiveTransfer(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[write.TransferReceive](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.ReceiveTransfer(r.Context(), chi.URLParam(r, "id"), body, write.ReceiveMeta{
		ReceivedBy: c.userID, ReceivedVia: "backoffice",
	}))
}

func (h *Handlers) CancelTransfer(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.CancelTransfer(r.Context(), chi.URLParam(r, "id")))
}

// ── Ingredients ────────────────────────────────────────────

func (h *Handlers) Ingredients(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query().Get("q")
	rows, total, err := h.Repo.Ingredients(r.Context(), p, l, q)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) CreateIngredient(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Ingredient](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateIngredient(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateIngredient(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Ingredient](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateIngredient(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteIngredient(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteIngredient(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) IngredientUsage(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.IngredientUsage(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── Ingredient location stock ops ─────────────────────────

func (h *Handlers) CreateIngredientLocationGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	type body struct {
		Supplier string                             `json:"supplier"`
		Note     string                             `json:"note"`
		Items    []write.IngredientGoodsReceiptItem `json:"items"`
	}
	b, ok := decodeWrite[body](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientGoodsReceipt{
		LocKind:  kind,
		LocID:    locID,
		Supplier: b.Supplier,
		Note:     b.Note,
		Items:    b.Items,
	}
	id, err := h.Write.CreateIngredientGoodsReceipt(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) AdjustIngredientLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	type body struct {
		IngredientID string  `json:"ingredientId"`
		NewQty       float64 `json:"newQty"`
		Reason       string  `json:"reason"`
	}
	b, ok := decodeWrite[body](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientAdjust{
		LocKind:      kind,
		LocID:        locID,
		IngredientID: b.IngredientID,
		NewQty:       b.NewQty,
		Reason:       b.Reason,
	}
	h.mutated(w, r, h.Write.AdjustIngredientStock(r.Context(), c.userID, in))
}

func (h *Handlers) IngredientLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, locID, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	rows, err := h.Repo.IngredientLocationStock(r.Context(), kind, locID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockResponse{Data: rows})
}

// ── Ingredient categories ──────────────────────────────────

func (h *Handlers) IngredientCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.IngredientCategories(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientCategoryListResponse{Data: rows})
}

func (h *Handlers) CreateIngredientCategory(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientCategory](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateIngredientCategory(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateIngredientCategory(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientCategory](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateIngredientCategory(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteIngredientCategory(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteIngredientCategory(r.Context(), chi.URLParam(r, "id")))
}

// ── Customer tags ──────────────────────────────────────────

func (h *Handlers) Tags(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Tags(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.TagListResponse{Data: rows})
}

func (h *Handlers) CreateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateTag(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateTag(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Tag](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateTag(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteTag(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteTag(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) SetCustomerTags(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.SetCustomerTagsInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetCustomerTags(r.Context(), chi.URLParam(r, "id"), in.TagIds))
}

// ── Customer segments ──────────────────────────────────────

func (h *Handlers) Segments(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.Segments(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.SegmentListResponse{Data: rows})
}

func (h *Handlers) CreateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	id, err := h.Write.CreateSegment(r.Context(), in)
	h.created(w, r, id, err)
}

func (h *Handlers) UpdateSegment(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Segment](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.UpdateSegment(r.Context(), chi.URLParam(r, "id"), in))
}

func (h *Handlers) DeleteSegment(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteSegment(r.Context(), chi.URLParam(r, "id")))
}

func (h *Handlers) ReorderSegments(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.ReorderSegmentsInput](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.ReorderSegments(r.Context(), in.OrderedIds))
}

// ── Customer interactions (SP-CRM-6) ───────────────────────

func (h *Handlers) Interactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.Interactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.InteractionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) CreateInteraction(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.Interaction](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateInteraction(r.Context(), chi.URLParam(r, "id"), in, c.userID, c.name)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	h.created(w, r, id, err)
}

func (h *Handlers) DeleteInteraction(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.DeleteInteraction(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "iid")))
}

// ── Customer points ledger (SP-CRM-7) ──────────────────────

func (h *Handlers) PointTransactions(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.PointTransactions(r.Context(), chi.URLParam(r, "id"), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.PointTransactionListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) AdjustPoints(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[api.AdjustPointsInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	bal, err := h.Write.AdjustPoints(r.Context(), chi.URLParam(r, "id"), in.Points, in.Reason, c.userID, c.name)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "pelanggan tidak ditemukan")
		return
	}
	if errors.Is(err, write.ErrZeroDelta) || errors.Is(err, write.ErrInsufficientPoints) || errors.Is(err, write.ErrReasonRequired) {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, api.AdjustPointsResponse{Data: struct {
		BalanceAfter int `json:"balanceAfter"`
	}{BalanceAfter: bal}})
}

func (h *Handlers) RewardGrants(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RewardGrants(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RewardGrantListResponse{Data: rows})
}

// ── Ingredient transfers ───────────────────────────────────

func (h *Handlers) IngredientTransfers(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	q := r.URL.Query()
	status := q.Get("status")
	from := q.Get("from")
	to := q.Get("to")
	locKind := q.Get("locKind")
	locID := q.Get("locID")
	if locKind != "" && locKind != "outlet" && locKind != "warehouse" {
		httpx.Err(w, http.StatusBadRequest, "locKind harus outlet atau warehouse")
		return
	}
	rows, total, err := h.Repo.IngredientTransfers(r.Context(), p, l, status, from, to, locKind, locID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientTransferListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) IngredientTransfer(w http.ResponseWriter, r *http.Request) {
	t, err := h.Repo.IngredientTransfer(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientTransferResponse{Data: t})
}

func (h *Handlers) CreateIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	// Body: {source:{kind,id}, dest:{kind,id}, note, items:[{ingredientId,qty}]}
	// write.IngredientTransferCreate has Source/Dest as TransferLoc{Kind,ID} — matches JSON exactly.
	in, ok := decodeWrite[write.IngredientTransferCreate](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	id, err := h.Write.CreateIngredientTransfer(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) SendIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.SendIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id")))
}

func (h *Handlers) ReceiveIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[write.IngredientTransferReceive](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.ReceiveIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in))
}

type ingredientTransferCancelBody struct {
	Reason string `json:"reason"`
}

func (h *Handlers) CancelIngredientTransfer(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[ingredientTransferCancelBody](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CancelIngredientTransfer(r.Context(), c.userID, chi.URLParam(r, "id"), in.Reason))
}

// ── Ingredient stock-counts ─────────────────────────────────

func (h *Handlers) IngredientStockCounts(w http.ResponseWriter, r *http.Request) {
	p, l := pageLimit(r)
	rows, total, err := h.Repo.IngredientStockCounts(r.Context(), p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockCountListResponse{Data: rows, Meta: *meta(total, p, l)})
}

func (h *Handlers) IngredientStockCount(w http.ResponseWriter, r *http.Request) {
	sc, err := h.Repo.IngredientStockCount(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, api.IngredientStockCountResponse{Data: sc})
}

func (h *Handlers) CreateIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	// Body: {name, location:{kind,id}, plannedDate?, notes?}
	type ingredientStockCountInput struct {
		Name        string            `json:"name"`
		Location    write.TransferLoc `json:"location"`
		PlannedDate string            `json:"plannedDate"`
		Notes       string            `json:"notes"`
	}
	b, ok := decodeWrite[ingredientStockCountInput](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	in := write.IngredientStockCount{
		Name:        b.Name,
		LocKind:     b.Location.Kind,
		LocID:       b.Location.ID,
		PlannedDate: b.PlannedDate,
		Notes:       b.Notes,
	}
	id, err := h.Write.CreateIngredientStockCount(r.Context(), c.userID, in)
	h.created(w, r, id, err)
}

func (h *Handlers) StartIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.StartIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}

type ingredientStockCountSaveBody struct {
	Items []write.IngredientStockCountSaveItem `json:"items"`
}

func (h *Handlers) SaveIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[ingredientStockCountSaveBody](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SaveIngredientStockCount(r.Context(), chi.URLParam(r, "id"), in.Items))
}

func (h *Handlers) CompleteIngredientStockCount(w http.ResponseWriter, r *http.Request) {
	h.mutated(w, r, h.Write.CompleteIngredientStockCount(r.Context(), chi.URLParam(r, "id")))
}

// ── Recipes (SP-Recipe-2) ──────────────────────────────────

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
	PromotionIDs      []string            `json:"promotionIds"`
	DiscountCodes     []string            `json:"discountCodes"`
	DiscountLabel     string              `json:"discountLabel"`
	DiscountBreakdown json.RawMessage     `json:"discountBreakdown"`
	PointsRedeemed    int                 `json:"pointsRedeemed"`
	Notes             string              `json:"notes"`
	ShiftID           string              `json:"shiftId"`
}

func (h *Handlers) CreateOrder(w http.ResponseWriter, r *http.Request) {
	h.createOrder(w, r, h.caller, h.OrderSvc.CreateOrder)
}

func (h *Handlers) createOrder(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	create func(context.Context, service.CreateOrderInput) (string, bool, bool, error),
) {
	body, ok := decodeWrite[createOrderBody](w, r)
	if !ok {
		return
	}
	c, _ := resolveCaller(r)
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
		PromotionIDs: body.PromotionIDs, DiscountCodes: body.DiscountCodes,
		DiscountLabel:     body.DiscountLabel,
		DiscountBreakdown: body.DiscountBreakdown,
		PointsRedeemed:    body.PointsRedeemed,
		Notes:             body.Notes, ShiftID: body.ShiftID, Offline: false,
	}
	// A42: a deadlock/serialization victim is re-run as a whole fresh transaction (the
	// processed_keys receipt makes a re-run after an applied commit a replay).
	var id string
	err := write.RetryBusy(r.Context(), func() error {
		var e error
		id, _, _, e = create(r.Context(), in)
		return e
	})
	if err != nil {
		if errors.Is(err, write.ErrBusy) {
			httpx.Err(w, http.StatusConflict, write.ErrBusy.Error()) // nothing applied, safe to retry
			return
		}
		var rej *service.ErrDiscountRejected
		if errors.As(err, &rej) {
			httpx.Err(w, http.StatusUnprocessableEntity, discountRejectMessage(rej.Violations))
			return
		}
		if errors.Is(err, service.ErrTenderRejected) {
			// The message carries only the cashier's own captured/due amounts.
			httpx.Err(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		if _, coded := apperr.CodeOf(err); !coded {
			// Unclassified (e.g. a database error): never echo its text to the client.
			slog.Error("create order failed", "idempotencyKey", idem, "err", err)
			httpx.Err(w, http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi")
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if h.Cache != nil {
		h.Cache.Set(r.Context(), "idem:"+idem, id, 24*60*60*1e9)
	}
	h.invalidate(r)
	h.returnOrder(w, r, id)
}

type loyaltyPreviewBody struct {
	CustomerID      string              `json:"customerId"`
	Total           float64             `json:"total"`
	ClientCreatedAt *time.Time          `json:"clientCreatedAt"`
	Items           []service.OrderItem `json:"items"`
}

// LoyaltyPreview returns the product_reward free-item menus a customer qualifies
// for on the current cart (online-only checkout preview; read-only).
func (h *Handlers) LoyaltyPreview(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeWrite[loyaltyPreviewBody](w, r)
	if !ok {
		return
	}
	if body.CustomerID == "" {
		httpx.Err(w, http.StatusBadRequest, "customerId required")
		return
	}
	rewards, err := h.OrderSvc.PreviewRewards(r.Context(), body.CustomerID, body.Items, body.Total, body.ClientCreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	out := make([]api.LoyaltyPreviewReward, 0, len(rewards))
	for _, rw := range rewards {
		products := make([]api.LoyaltyPreviewProduct, 0, len(rw.Products))
		for _, p := range rw.Products {
			vs := make([]api.LoyaltyPreviewVariant, 0, len(p.Variants))
			for _, v := range p.Variants {
				vs = append(vs, api.LoyaltyPreviewVariant{Size: v.Size, Price: float32(v.Price)})
			}
			products = append(products, api.LoyaltyPreviewProduct{Id: p.ID, Name: p.Name, Variants: vs})
		}
		out = append(out, api.LoyaltyPreviewReward{
			ConditionId: rw.ConditionID, ConditionName: rw.ConditionName, Products: products,
		})
	}
	// writeJSON (not httpx.JSON): LoyaltyPreviewResponse already carries the
	// {data:...} envelope, so httpx.JSON would double-wrap it ({data:{data:...}}).
	writeJSON(w, http.StatusOK, api.LoyaltyPreviewResponse{Data: out})
}

func (h *Handlers) returnOrder(w http.ResponseWriter, r *http.Request, id string) {
	o, err := h.Repo.Order(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o})
}

// refundHTTPError maps a refund failure to the direct route's response. Business
// refusals keep their (Indonesian) text; anything else is a server fault whose raw
// text stays in the log, never in the response (A06).
func refundHTTPError(err error) (int, string) {
	if code, ok := apperr.CodeOf(err); ok {
		switch code {
		case apperr.Rejected:
			return http.StatusBadRequest, err.Error()
		case apperr.Forbidden:
			return http.StatusForbidden, err.Error()
		case apperr.Conflict, apperr.Busy:
			return http.StatusConflict, err.Error()
		}
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40P01", "40001", "55P03": // lock conflict: nothing applied, retry later
			return http.StatusConflict, write.ErrBusy.Error()
		}
	}
	return http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi"
}

func (h *Handlers) RefundOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason string `json:"reason"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Isi permintaan refund tidak valid.")
		return
	}
	id := chi.URLParam(r, "id")
	fail := func(err error) {
		status, msg := refundHTTPError(err)
		if status >= http.StatusInternalServerError {
			slog.Error("refund failed", "orderId", id, "err", err)
		}
		httpx.Err(w, status, msg)
	}
	// The shared input rules run first so a malformed id or reason never reaches SQL.
	if _, err := service.NormalizeRefund(id, body.Reason); err != nil {
		fail(err)
		return
	}
	c, _ := h.caller(r)
	outlet := c.outletID
	if outlet == "" {
		// An admin on "Semua outlet" refunds at the order's own outlet (no new
		// authority); any other caller without an outlet is refused.
		if c.role != "admin" {
			httpx.Err(w, http.StatusForbidden, "Outlet aktif belum dipilih untuk akun ini.")
			return
		}
		o, err := h.OrderSvc.OrderOutlet(r.Context(), id)
		if err != nil {
			fail(err)
			return
		}
		outlet = o
	}
	// Direct (backoffice/API) refunds are paid from no shift's drawer (owner B2).
	if err := write.RetryBusy(r.Context(), func() error {
		return h.OrderSvc.Refund(r.Context(), service.RefundInput{
			OutletID: outlet, OrderID: id, Reason: body.Reason,
			UserID: c.userID, UserName: c.name,
		})
	}); err != nil {
		fail(err)
		return
	}
	h.invalidate(r)
	// The refund is committed: read it back at the outlet it ran at (the request's
	// scope is empty for an admin on "Semua outlet"), and never echo a raw read error.
	o, err := h.Repo.Order(r.Context(), read.Scope{OutletID: outlet}, id)
	if err != nil {
		slog.Error("refund committed but the read-back failed", "orderId", id, "outletId", outlet, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "Refund tersimpan, tetapi data transaksi belum dapat dimuat. Segarkan halaman dan jangan refund ulang.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o})
}

func (h *Handlers) OpenShift(w http.ResponseWriter, r *http.Request) {
	h.openShift(w, r, h.caller, h.OrderSvc.OpenShift)
}

func (h *Handlers) openShift(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	open func(context.Context, service.OpenShiftInput) (string, error),
) {
	body, err := service.DecodeOpenShift(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	c, _ := resolveCaller(r)
	id, err := open(r.Context(), service.OpenShiftInput{
		OutletID: c.outletID, OutletName: body.OutletName,
		CashierID: c.userID, CashierName: c.name, StartingCash: body.StartingCash,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	v, rerr := h.Repo.Shift(r.Context(), scope(r), id)
	v = shiftOrReceipt(v, rerr, openShiftReceipt(id, c.outletID, c.userID, c.name, body.OutletName, body.StartingCash, time.Now()))
	writeJSON(w, http.StatusCreated, map[string]any{"data": nullableShift(v)})
}

func (h *Handlers) CloseShift(w http.ResponseWriter, r *http.Request) {
	h.closeShift(w, r, h.caller, h.OrderSvc.CloseShift)
}

func (h *Handlers) closeShift(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	close func(context.Context, string, string, float64, map[string]float64) error,
) {
	body, err := service.DecodeCloseShift(r.Body, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	c, _ := resolveCaller(r)
	if err := close(r.Context(), c.outletID, chi.URLParam(r, "id"), body.ClosingCash, body.CountedByMethod); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	h.invalidate(r)
	shiftID := chi.URLParam(r, "id")
	v, rerr := h.Repo.Shift(r.Context(), scope(r), shiftID)
	v = shiftOrReceipt(v, rerr, closedShiftReceipt(shiftID, c.outletID, body.ClosingCash, time.Now()))
	writeJSON(w, http.StatusOK, map[string]any{"data": nullableShift(v)})
}

// Limits for POST /error-logs. The tablet sends small batches (it chunks at 10);
// anything beyond these is refused whole rather than partially stored.
const (
	errorLogsBodyLimit = 256 << 10
	maxErrorLogItems   = 50
)

// CreateErrorLogs records a batch of client errors (sync/runtime/print). Outlet
// and user come from the JWT; the rest from the body. Every row is redacted and
// capped inside write.InsertErrorLogs; the batch is stored atomically.
func (h *Handlers) CreateErrorLogs(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, errorLogsBodyLimit)
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
	if err := httpx.DecodeLoose(r, &body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, "error log batch too large")
			return
		}
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.Items) > maxErrorLogItems {
		httpx.Err(w, http.StatusBadRequest, "too many error log items")
		return
	}
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
		slog.Error("error log insert failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "failed to store error logs")
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
	if err := h.OrderSvc.ValidateShiftOutlet(r.Context(), c.outletID, body.ShiftID); err != nil {
		if errors.Is(err, service.ErrShiftNotInOutlet) {
			httpx.Err(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Error("shift ownership check failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi")
		return
	}
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
	// No outlet guard — the repo (lockCount) authorizes: outlet counts must match
	// the caller's outlet; warehouse counts are permission-gated by the route.
	err := h.Write.UpdateStockCount(r.Context(), chi.URLParam(r, "id"), c.outletID, body)
	if countConflict(w, err) {
		return
	}
	h.mutated(w, r, err)
}

// countConflict answers a stock count lifecycle refusal (apperr.Conflict) with 409
// and its Indonesian message; every other error is left to the caller's mapping.
func countConflict(w http.ResponseWriter, err error) bool {
	if code, ok := apperr.CodeOf(err); ok && code == apperr.Conflict {
		httpx.Err(w, http.StatusConflict, err.Error())
		return true
	}
	return false
}

func (h *Handlers) CompleteStockCount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []write.StockCountItem `json:"items"`
	}
	// Empty body = finalize from the stored draft items; a malformed one is a 400
	// with nothing applied.
	if err := decodeOptionalBody(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := h.caller(r)
	// No outlet guard — repo authorizes (see UpdateStockCount).
	id := chi.URLParam(r, "id")
	if err := h.Write.CompleteStockCount(r.Context(), id, c.outletID, body.Items); err != nil {
		if errors.Is(err, write.ErrNotFound) {
			httpx.Err(w, http.StatusNotFound, "not found")
			return
		}
		if errors.Is(err, write.ErrBusy) {
			httpx.Err(w, http.StatusConflict, err.Error()) // nothing applied, safe to retry
			return
		}
		if countConflict(w, err) {
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
	// Outlet-less accounts (admin before a terminal outlet is chosen) get the same
	// 403 as /sync/pull, not a 500 from an empty-uuid lookup. Clients read a 4xx as
	// "reachable, account problem" (A04).
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
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
	h.syncBatch(w, r, h.caller, h.Sync.ProcessBatch)
}

// Keep the trusted HTTP mapping testable without a database identity lookup.
func (h *Handlers) syncBatch(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	process func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error),
) {
	items, err := decodeBatchEnvelope(r.Body)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, _ := resolveCaller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	res, err := process(r.Context(), syncpkg.Caller{
		OutletID: c.outletID, UserID: c.userID, DisplayName: c.name,
		Role: c.role, HomeOutletID: c.homeOutletID,
		CanRefund: auth.HasPermission(r.Context(), "process_refund"),
	}, items)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	h.invalidate(r)
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

func (h *Handlers) GetInboundTransfers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		return
	}
	rows, err := h.Repo.TransfersForOutlet(r.Context(), c.outletID, "in_transit")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}

func (h *Handlers) GetOutletTransfers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	status := r.URL.Query().Get("status")
	if status != "completed" && status != "cancelled" {
		httpx.Err(w, http.StatusBadRequest, "status harus completed atau cancelled")
		return
	}
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		return
	}
	rows, err := h.Repo.OutletTransferHistory(r.Context(), c.outletID, status)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
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

// ── Inventory location stock ops ───────────────────────────

// locTarget extracts and validates kind+id query params for polymorphic
// location endpoints (kind must be "outlet" or "warehouse", id must be set).
func locTarget(r *http.Request) (kind, id string, ok bool) {
	kind = r.URL.Query().Get("kind")
	id = r.URL.Query().Get("id")
	return kind, id, (kind == "warehouse" || kind == "outlet") && id != ""
}

func (h *Handlers) CreateLocationGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	g, ok := decodeWrite[write.GoodsReceipt](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.CreateLocationGoodsReceipt(r.Context(), kind, id, c.userID, g))
}

func (h *Handlers) AdjustLocationStock(w http.ResponseWriter, r *http.Request) {
	kind, id, ok := locTarget(r)
	if !ok {
		httpx.Err(w, http.StatusBadRequest, "kind ('outlet'/'warehouse') dan id wajib")
		return
	}
	a, ok := decodeWrite[write.WarehouseAdjust](w, r)
	if !ok {
		return
	}
	c, _ := h.caller(r)
	h.mutated(w, r, h.Write.AdjustLocationStock(r.Context(), kind, id, c.userID, a))
}

func (h *Handlers) SetOutletPar(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		httpx.Err(w, http.StatusBadRequest, "id outlet wajib")
		return
	}
	body, ok := decodeWrite[write.OutletPar](w, r)
	if !ok {
		return
	}
	h.mutated(w, r, h.Write.SetOutletPar(r.Context(), id, body.ProductID, body.VariantSize, body.ParLevel))
}

func (h *Handlers) InventoryOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.InventoryOverview(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) IngredientOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.IngredientOverview(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) MovementSummary(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	id := r.URL.Query().Get("id")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if (kind != "outlet" && kind != "warehouse") || id == "" || from == "" || to == "" {
		httpx.Err(w, http.StatusBadRequest, "kind, id, from, to wajib")
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.MovementSummary(r.Context(), kind, id, from, to, p, l)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.MovementSummaryResponse{Data: rows, Meta: *meta(total, p, l)})
}

// discountRejectMessage turns the first promo violation into an Indonesian cashier
// message for an online-rejected discount (SP-Promo-1).
func discountRejectMessage(v []service.PromoViolation) string {
	if len(v) == 0 {
		return "Diskon tidak berlaku"
	}
	switch v[0] {
	case service.ViolationExpired:
		return "Kode/promo sudah kadaluarsa"
	case service.ViolationNotStarted:
		return "Promo belum dimulai"
	case service.ViolationBelowMin:
		return "Belum memenuhi minimum belanja"
	case service.ViolationOutsideHours:
		return "Promo tidak berlaku pada jam ini"
	case service.ViolationWrongDay:
		return "Promo tidak berlaku hari ini"
	case service.ViolationWrongOutlet:
		return "Promo tidak berlaku di outlet ini"
	case service.ViolationUsageLimit:
		return "Kuota kode diskon sudah habis"
	case service.ViolationNotFound:
		return "Diskon tidak ditemukan"
	case service.ViolationNotCombinable:
		return "Promo/kode ini tidak bisa digabung"
	case service.ViolationCodeOnly:
		return "Promo ini hanya bisa dipakai lewat kode"
	case service.ViolationRewardInvalid:
		return "Hadiah promo tidak valid atau melebihi kuota"
	case service.ViolationBundleInvalid:
		return "Bundel tidak valid atau syaratnya tidak terpenuhi"
	case service.ViolationRequiresCustomer:
		return "Kode ini butuh pelanggan terdaftar"
	case service.ViolationPerCustomerCapReached:
		return "Pelanggan sudah mencapai batas pemakaian kode ini"
	case service.ViolationWrongCustomer:
		return "Kode ini khusus untuk pelanggan tertentu"
	default:
		return "Diskon tidak berlaku"
	}
}
