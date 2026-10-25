package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// outletInScope reports whether the caller may touch this outlet: admins any, an
// outlet-bound user only their own (the outlet id comes from the path, so it is checked
// explicitly rather than trusted).
func outletInScope(r *http.Request, outletID string) bool {
	sc := scope(r)
	return sc.CrossAll || strings.EqualFold(sc.OutletID, outletID)
}

// GetOutletGiveaway answers the outlet's per-sale giveaway setting (200 with
// configured=false when none; 404 only for an unknown outlet).
func (h *Handlers) GetOutletGiveaway(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !outletInScope(r, id) {
		httpx.Err(w, http.StatusForbidden, "forbidden")
		return
	}
	v, err := read.OutletGiveawayOn(r.Context(), h.Write.Pool, id)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// SetOutletGiveaway saves the setting. Idempotency-Key is required (400 without it).
func (h *Handlers) SetOutletGiveaway(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(r.Header.Get("Idempotency-Key")) == "" {
		httpx.Err(w, http.StatusBadRequest, "header Idempotency-Key wajib")
		return
	}
	id := chi.URLParam(r, "id")
	if !outletInScope(r, id) {
		httpx.Err(w, http.StatusForbidden, "forbidden")
		return
	}
	var body struct {
		ProductID   string `json:"productId"`
		VariantSize string `json:"variantSize"`
		Enabled     *bool  `json:"enabled"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
		return
	}
	if _, err := uuid.Parse(body.ProductID); err != nil || strings.TrimSpace(body.VariantSize) == "" || body.Enabled == nil {
		httpx.Err(w, http.StatusBadRequest, "productId, variantSize dan enabled wajib diisi")
		return
	}
	in := write.OutletGiveawayInput{ProductID: body.ProductID, VariantSize: body.VariantSize, Enabled: *body.Enabled}
	erpOn := h.erpEnabled
	actor := callerUserID(r)
	h.keyedMutated(w, r, keyedWrite{
		OpType:  "bo.outlet_giveaway.set",
		Payload: map[string]any{"outletId": id, "in": in},
		Unkeyed: func() error { return errors.New("idempotency key required") }, // unreachable: checked above
		Effect: func(ctx context.Context, tx pgx.Tx) error {
			return h.Write.SetOutletGiveawayTx(ctx, tx, id, actor, in, erpOn)
		},
		Outcome: func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error) {
			v, err := read.OutletGiveawayOn(ctx, q, id)
			if err != nil {
				return nil, err
			}
			return json.Marshal(map[string]any{"data": v})
		},
		OnErr: func(w http.ResponseWriter, err error) bool {
			if errors.Is(err, write.ErrGiveawayVariantMissing) || errors.Is(err, write.ErrGiveawayUnmapped) {
				httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
				return true
			}
			return false
		},
	})
}
