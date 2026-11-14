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
	// Replacement is the corrected sale of mode "replace" ("Batalkan & perbaiki"). It commits with
	// the void or not at all.
	Replacement *replacementPayload `json:"replacement"`
}

// replacementPayload is a void's replacement sale: an ordinary order payload plus how its amount is
// settled. CorrectionTarget "original_total" books the gap to the cart price as "Penyesuaian
// koreksi"; absent, the customer pays or receives the difference (only an own-shift void in a still
// open shift may do that; the server forces the original total in every other case).
type replacementPayload struct {
	orderPayload
	CorrectionTarget string `json:"correctionTarget"`
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
		DeviceID: c.EnvelopeDeviceID, CallerShiftID: c.EnvelopeShiftID,
		CanVoidOwnShift: c.CanVoidOwnShift, CanVoidAny: c.CanVoidAny,
		EnvelopeDeviceID: c.EnvelopeDeviceID, Channel: "sync",
	}
	if in.DeviceID == "" {
		in.DeviceID = p.DeviceID // legacy item without an envelope
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
	switch p.Mode {
	case string(service.VoidModeNone):
	case string(service.VoidModeReplace):
		if p.Replacement == nil {
			return fail(service.ErrVoidReplacementInvalid)
		}
	default: // "later" is a Backoffice mode
		return fail(service.ErrVoidReplacementInvalid)
	}
	if p.DeviceID == "" {
		p.DeviceID = c.EnvelopeDeviceID
	}
	out, err := e.keyedOutcome(ctx, c, it, func(tx pgx.Tx) (receiptOutcome, error) {
		orderID, rerr := e.refundSaleID(ctx, tx, c.OutletID, p.OrderID, p.SaleOrderUUID, p.DeviceID)
		if rerr != nil {
			return receiptOutcome{}, voidResolveErr(rerr)
		}
		var res service.VoidResult
		var verr error
		if p.Mode == string(service.VoidModeReplace) {
			res, verr = e.voidAndReplace(ctx, tx, c, it, p, orderID)
		} else {
			res, verr = e.Orders.VoidOrderTx(ctx, tx, p.input(c, orderID))
		}
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

// voidAndReplace applies a void with its replacement inside the item's receipt transaction. The
// replacement's key is the item key plus ":replacement".
func (e *Engine) voidAndReplace(ctx context.Context, tx pgx.Tx, c Caller, it BatchItem, p voidPayload, orderID string) (service.VoidResult, error) {
	in := p.input(c, orderID)
	in.ReplacementAtOriginalTotal = p.Replacement.CorrectionTarget == "original_total"
	repl := e.replacementInput(c, it, p.Replacement.orderPayload, it.IdempotencyKey+":replacement", decodeEnvelope(it))
	return e.Orders.VoidAndReplaceTx(ctx, tx, in, repl)
}

// replacementInput builds the sale input of a replacement the way `case "order"` builds a sale. The
// shift is pinned by the service to the voided sale's, never taken from the payload.
func (e *Engine) replacementInput(c Caller, it BatchItem, p orderPayload, key string, env Envelope) service.CreateOrderInput {
	evalTime, skew := boundSaleTime(readEvidence(env, e.now(), e.ContactKey), p.ClientCreatedAt, e.now())
	return p.createInput(c, key, "", evalTime, skew)
}

// processReplacementOrder runs an `order` item that carries replacesOrderId ("Buat pengganti").
// A key that already committed answers duplicate with the stored id before any permission check.
func (e *Engine) processReplacementOrder(ctx context.Context, c Caller, it BatchItem, r ItemResult, p orderPayload, env Envelope, fail func(error) ItemResult) ItemResult {
	in := e.replacementInput(c, it, p, it.IdempotencyKey, env)
	in.ReplacesOrderID = p.ReplacesOrderID
	res, err := e.Orders.CreateReplacementOrder(ctx, in, c.CanVoidAny, "")
	if err != nil {
		return fail(err)
	}
	r.OrderID, r.StockWarning = res.OrderID, res.StockWarning
	if res.Duplicate {
		r.Status = "duplicate"
		return r
	}
	r.Status = "ok"
	if res.StockSeq != nil && !e.StockSeqOff {
		seq := *res.StockSeq
		r.StockSeq, r.attributedOutlet = &seq, c.OutletID
	}
	return r
}
