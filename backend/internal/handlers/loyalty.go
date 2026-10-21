package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

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

type loyaltyPreviewBody struct {
	CustomerID      string              `json:"customerId"`
	Total           float64             `json:"total"`
	ClientCreatedAt *time.Time          `json:"clientCreatedAt"`
	Items           []service.OrderItem `json:"items"`
}

// previewClock bounds the client-supplied preview time (A05): the preview is online-only,
// so a clock more than the sync tolerance away from the server's is not trusted and the
// server's time is used instead.
func previewClock(c *time.Time, now time.Time) *time.Time {
	if c == nil {
		return nil
	}
	if d := c.Sub(now); d > syncpkg.ClockTolerance || d < -syncpkg.ClockTolerance {
		return &now
	}
	return c
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
	// Same outlet resolution as CreateOrder (caller falls back to the user's home outlet), so the
	// preview's clock matches the commit's.
	c, _ := h.caller(r)
	rewards, err := h.OrderSvc.PreviewRewards(r.Context(), body.CustomerID, body.Items, body.Total, previewClock(body.ClientCreatedAt, time.Now()), c.outletID)
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
