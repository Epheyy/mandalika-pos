package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

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
	// No outlet guard — repo authorizes (see UpdateStockCount). The outlet is the
	// authenticated caller's, never the body's.
	id := chi.URLParam(r, "id")
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.stock_count.complete",
		Payload: map[string]any{"countId": id, "outletId": c.outletID, "items": body.Items},
		Unkeyed: func() error {
			return h.Write.CompleteStockCountBy(r.Context(), id, c.outletID, callerUserID(r), body.Items)
		},
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.CompleteStockCountTx(ctx, tx, id, c.outletID, callerUserID(r), body.Items)
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			v, err := read.StockCountOn(ctx, q, scope(r), id)
			if err != nil {
				return nil, err
			}
			return json.Marshal(map[string]any{"data": v})
		},
		OnErr: func(w http.ResponseWriter, err error) bool { return countConflict(w, err) },
	})
}
