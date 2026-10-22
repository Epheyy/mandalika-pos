package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

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

func (h *Handlers) CreateCashFlow(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ShiftID     string  `json:"shiftId"`
		Type        string  `json:"type"`
		Amount      float64 `json:"amount"`
		Description string  `json:"description"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		writeDecodeErr(w, err)
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
	in := service.CashFlowInput{
		OutletID: c.outletID, ShiftID: body.ShiftID, Type: body.Type,
		Amount: body.Amount, Description: body.Description,
		CashierID: c.userID, CashierName: c.name,
	}
	var id string
	h.keyedMutated(w, r, keyedWrite{
		OpType: "bo.cash_flow.create",
		Payload: map[string]any{"outletId": c.outletID, "shiftId": body.ShiftID, "type": body.Type,
			"amount": body.Amount, "description": body.Description},
		Status: http.StatusCreated,
		Unkeyed: func() (err error) {
			id, err = h.OrderSvc.AddCashFlow(r.Context(), in)
			return err
		},
		Effect: func(ctx context.Context, tx pgx.Tx) (err error) {
			id, err = h.OrderSvc.AddCashFlowTx(ctx, tx, in)
			return err
		},
		Outcome: func(context.Context, read.RowQuerier) (json.RawMessage, error) {
			return json.Marshal(map[string]any{"data": map[string]string{"id": id}})
		},
	})
}
