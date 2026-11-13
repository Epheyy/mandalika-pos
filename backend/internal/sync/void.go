package sync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
)

// voidPayload is the sync `void` payload (Void phase 1: mode "none" only). The display-only keys
// (orderNumber, total, restockLines, originalTenders, originalShiftId) are for the tablet's own
// overlays; the server ignores them and reads everything that matters from the database.
type voidPayload struct {
	OrderID       string `json:"orderId"`
	SaleOrderUUID string `json:"saleOrderUuid"`
	DeviceID      string `json:"deviceId"`
	ReasonCode    string `json:"reasonCode"`
	Note          string `json:"note"`
	Mode          string `json:"mode"`
	// StockChoices maps a sale-movement key to "restock" or "skip_counted". An unknown value is
	// treated as no choice, which refuses a counted line (never a silent default).
	StockChoices map[string]string `json:"stockChoices"`
	// OrderUUID is the outbox item's client uuid (commitOutbox adds it): the void's own id.
	OrderUUID string `json:"orderUuid"`
}

// input builds the service input. Rights come from the Caller (the request's token), the shift and
// device from the verified envelope, never from the payload. A client uuid that is not canonical is
// dropped (it only feeds the defence-in-depth unique row).
func (p voidPayload) input(c Caller, orderID string) service.VoidInput {
	in := service.VoidInput{
		OutletID: c.OutletID, OrderID: orderID,
		Reason: service.VoidReasonCode(p.ReasonCode), Note: p.Note,
		Mode: service.VoidMode(p.Mode), Source: service.VoidSourcePOS,
		UserID: c.UserID, UserName: c.DisplayName,
		DeviceID: p.DeviceID, CallerShiftID: c.EnvelopeShiftID,
		CanVoidOwnShift: c.CanVoidOwnShift, CanVoidAny: c.CanVoidAny,
		EnvelopeDeviceID: c.EnvelopeDeviceID, Channel: "sync",
	}
	if in.DeviceID == "" {
		in.DeviceID = c.EnvelopeDeviceID
	}
	if service.IsCanonicalUUID(p.OrderUUID) {
		in.ClientVoidUUID = strings.ToLower(p.OrderUUID)
	}
	if len(p.StockChoices) > 0 {
		in.StockChoices = make(map[string]service.VoidStockChoice, len(p.StockChoices))
		for k, v := range p.StockChoices {
			in.StockChoices[k] = service.VoidStockChoice(v)
		}
	}
	return in
}

// voidResolveErr rewords the refund-worded sale-resolution errors for the void review screen.
func voidResolveErr(err error) error {
	switch {
	case errors.Is(err, service.ErrRefundOrderNotFound), errors.Is(err, service.ErrRefundOrderInvalid):
		return service.ErrVoidNotFound
	case errors.Is(err, service.ErrRefundOrderMismatch), errors.Is(err, service.ErrRefundSaleOtherDevice):
		return apperr.New(apperr.Rejected, "Transaksi yang dibatalkan tidak cocok dengan tablet ini.")
	}
	return err
}

// processVoid runs one sync `void` item. A caller without either void permission is refused
// forbidden (A06) unless the same key already committed, which replays as ok (M3). The void and its
// operation receipt commit in one transaction, so a double submission applies once.
func (e *Engine) processVoid(ctx context.Context, c Caller, it BatchItem, r ItemResult, fail func(error) ItemResult) ItemResult {
	if !c.CanVoidOwnShift && !c.CanVoidAny {
		out, applied, aerr := e.alreadyApplied(ctx, c, it)
		if aerr != nil {
			return fail(aerr)
		}
		if applied {
			r.Status, r.OrderID, r.ReplacementOrderID = "ok", out.ID, out.ReplacementOrderID
			return r
		}
		return fail(service.ErrVoidForbidden)
	}
	var p voidPayload
	if err := json.Unmarshal(it.Payload, &p); err != nil {
		return fail(apperr.Wrap(apperr.Rejected, err))
	}
	if p.Mode != string(service.VoidModeNone) {
		return fail(service.ErrVoidReplacementInvalid) // replacements arrive in Void phase 2
	}
	out, err := e.keyedOutcome(ctx, c, it, func(tx pgx.Tx) (receiptOutcome, error) {
		orderID, rerr := e.refundSaleID(ctx, tx, c.OutletID, p.OrderID, p.SaleOrderUUID, p.DeviceID)
		if rerr != nil {
			return receiptOutcome{}, voidResolveErr(rerr)
		}
		res, verr := e.Orders.VoidOrderTx(ctx, tx, p.input(c, orderID))
		if verr != nil {
			return receiptOutcome{}, verr
		}
		return receiptOutcome{OrderID: orderID, ReplacementOrderID: res.ReplacementOrderID}, nil
	})
	if err != nil {
		return fail(err)
	}
	r.Status, r.OrderID, r.ReplacementOrderID = "ok", out.OrderID, out.ReplacementOrderID
	return r
}
