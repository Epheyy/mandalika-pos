package handlers

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

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
	uid := callerUserID(r)
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.goods_receipt", Payload: map[string]any{"kind": kind, "id": id, "body": g},
		Unkeyed: func() error { return h.Write.CreateLocationGoodsReceipt(r.Context(), kind, id, uid, g) },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CreateLocationGoodsReceiptTx(ctx, tx, kind, id, uid, g)
		},
	})
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
	uid := callerUserID(r)
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.inventory.adjust", Payload: map[string]any{"kind": kind, "id": id, "body": a},
		Unkeyed: func() error { return h.Write.AdjustLocationStock(r.Context(), kind, id, uid, a) },
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.AdjustLocationStockTx(ctx, tx, kind, id, uid, a)
		},
		// 409 {error, data:{code:"approval_required"}} while inventoryApprovalRequired is on.
		OnErr: func(w http.ResponseWriter, err error) bool {
			if errors.Is(err, write.ErrApprovalRequired) {
				writeApprovalRequired(w, err)
				return true
			}
			return false
		},
	})
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
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handlers) IngredientOverview(w http.ResponseWriter, r *http.Request) {
	resp, err := h.Repo.IngredientOverview(r.Context())
	if err != nil {
		writeErr(w, r, 500, err)
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
		writeErr(w, r, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.MovementSummaryResponse{Data: rows, Meta: *meta(total, p, l)})
}
