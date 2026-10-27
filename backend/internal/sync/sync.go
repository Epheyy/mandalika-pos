// Package sync implements the offline POS contract (plan §5, §5a): the
// content-version sync wall, delta pull of reference data, and idempotent
// outbox batch processing.
package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

type Engine struct {
	Pool   *pgxpool.Pool
	Read   *read.Repo
	Orders *service.OrderService
	Write  *write.Repo
	// Receipts gives refund, shift_open, shift_close, cash_flow and customer_create
	// exactly-once semantics per idempotency key (A11). Nil runs them unkeyed.
	Receipts service.ReceiptRunner
	// LegacyEnvelopeUntil ends the grace period for items without a capture-time
	// envelope (SYNC_LEGACY_ENVELOPE_UNTIL). Zero = no cutoff: accept and warn.
	LegacyEnvelopeUntil time.Time
	// WorkBudget bounds the item-processing time of one batch (zero = DefaultWorkBudget).
	WorkBudget time.Duration
	// testProcess and testVersion replace processOne and Version (tests only).
	testProcess func(context.Context, Caller, BatchItem) ItemResult
	testVersion func(context.Context, string) (VersionInfo, error)
	// Now is injectable for tests; nil = time.Now.
	Now func() time.Time
	// Lookup is injectable for tests; nil = queries on Pool.
	Lookup attributionLookup
	// ContactKey signs and verifies offline contacts (A05), derived from the access
	// secret by DeriveContactKey. Empty = no signed contacts: /sync/version issues none
	// and the cap uses the device-reported elapsed time alone.
	ContactKey []byte
	// SaleResolver maps a sale's client orderUuid to its server id and device (A41);
	// nil = a query on the refund's transaction. Injectable for tests.
	SaleResolver saleResolver
	// StockSeqOff is the SYNC_STOCK_SEQ=off kill switch (A15 Phase B): every stockSeq is
	// omitted from /sync/version, /sync/pull and the batch result, and tablets fall back
	// to Phase A plus auto-pull. The counter itself keeps counting.
	StockSeqOff bool
}

// saleResolver resolves a sale by order_uuid within one outlet. A missing sale must
// return service.ErrRefundOrderNotFound.
type saleResolver func(ctx context.Context, tx pgx.Tx, outletID, orderUUID string) (id, deviceID string, err error)

// refundPayload is the sync `refund` payload. C4a keys (items, refundAmount, reasonCode,
// orderUuid) are additive: an old tablet omits them and gets the legacy whole-order refund.
type refundPayload struct {
	OrderID       string `json:"orderId"`
	Reason        string `json:"reason"`
	SaleOrderUUID string `json:"saleOrderUuid"`
	DeviceID      string `json:"deviceId"`
	// Items stays nil when the key is absent or null (legacy shape); `[]` decodes to an empty
	// non-nil slice, which the service rejects instead of refunding everything.
	// Item fields are pointers so a missing or misspelled key is detected instead of
	// silently meaning line 0 / quantity 0.
	Items []struct {
		LineNo   *int `json:"lineNo"`
		Quantity *int `json:"quantity"`
	} `json:"items"`
	RefundAmount *float64 `json:"refundAmount"`
	ReasonCode   string   `json:"reasonCode"`
	// OrderUUID is the outbox item's client uuid (commitOutbox adds it): the refund's own id.
	OrderUUID string `json:"orderUuid"`
}

// input builds the service input. A refundAmount that is not a finite whole-or-fractional
// rupiah figure becomes -1 so the service flags it instead of trusting it; a client uuid that
// is not canonical is dropped (it only feeds the defence-in-depth unique row).
func (p refundPayload) input(c Caller, orderID string) service.RefundInput {
	in := service.RefundInput{
		OutletID: c.OutletID, OrderID: orderID, Reason: p.Reason,
		ShiftID: c.EnvelopeShiftID, UserID: c.UserID, UserName: c.DisplayName,
		Channel: "sync", ReasonCode: p.ReasonCode, DeviceID: p.DeviceID,
	}
	if service.IsCanonicalUUID(p.OrderUUID) {
		in.ClientRefundUUID = strings.ToLower(p.OrderUUID)
	}
	if p.Items != nil {
		in.Items = make([]service.RefundItemInput, len(p.Items))
		for i, it := range p.Items {
			if it.LineNo == nil || it.Quantity == nil {
				// A malformed item must never become line 0: mark it invalid so the service
				// rejects the refund as ErrRefundLineUnknown.
				in.Items[i] = service.RefundItemInput{LineNo: -1, Quantity: 0}
				continue
			}
			in.Items[i] = service.RefundItemInput{LineNo: *it.LineNo, Quantity: *it.Quantity}
		}
	}
	if p.RefundAmount != nil {
		v := int64(-1)
		if a := math.Round(*p.RefundAmount); a >= 0 && a <= 1e12 {
			v = int64(a)
		}
		in.RefundAmount = &v
	}
	return in
}

func resolveSaleTx(ctx context.Context, tx pgx.Tx, outletID, orderUUID string) (string, string, error) {
	if tx == nil {
		return "", "", service.ErrRefundOrderNotFound
	}
	var id string
	var dev *string
	err := tx.QueryRow(ctx,
		`SELECT id, device_id FROM orders WHERE order_uuid=$1 AND outlet_id=$2`,
		orderUUID, outletID).Scan(&id, &dev)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", service.ErrRefundOrderNotFound
	}
	if err != nil {
		return "", "", err
	}
	if dev == nil {
		return id, "", nil
	}
	return id, *dev, nil
}

// refundSaleID returns the server order id a refund applies to. A payload with
// saleOrderUuid is resolved here, inside the keyed transaction, so the receipt
// records the resolved id and a replay returns the same one (A41).
func (e *Engine) refundSaleID(ctx context.Context, tx pgx.Tx, outletID, orderID, saleUUID, deviceID string) (string, error) {
	if saleUUID == "" {
		return orderID, nil
	}
	if !service.IsCanonicalUUID(saleUUID) {
		return "", service.ErrRefundOrderInvalid
	}
	resolve := e.SaleResolver
	if resolve == nil {
		resolve = resolveSaleTx
	}
	id, saleDevice, err := resolve(ctx, tx, outletID, saleUUID)
	if err != nil {
		return "", err
	}
	if deviceID == "" || !strings.EqualFold(saleDevice, deviceID) {
		return "", service.ErrRefundSaleOtherDevice
	}
	if orderID != "" && orderID != id {
		return "", service.ErrRefundOrderMismatch
	}
	return id, nil
}

func New(p *pgxpool.Pool, rd *read.Repo, os *service.OrderService, wr *write.Repo) *Engine {
	return &Engine{Pool: p, Read: rd, Orders: os, Write: wr, Receipts: service.PoolReceiptRunner(p)}
}

func (e *Engine) processOne(ctx context.Context, c Caller, it BatchItem) ItemResult {
	return e.processOneWithRefund(ctx, c, it, e.Orders.RefundLinesTx)
}

// refundFunc runs a refund inside the transaction that also holds the item's
// operation receipt.
type refundFunc func(ctx context.Context, tx pgx.Tx, in service.RefundInput) (service.RefundResult, error)

// receiptOutcome is the stored result of a keyed write. Every type replays as
// status "ok" with the same orderId the first attempt returned.
type receiptOutcome struct {
	OrderID string `json:"orderId"`
	// RefundState ("partial"|"full") is stored for refunds only, so a replay acks the same
	// state; receipts written before C4a lack it and replay without one.
	RefundState string `json:"refundState,omitempty"`
}

// keyed runs effect exactly once for it.IdempotencyKey (A11): a retry after a lost
// response replays the first attempt's orderId instead of applying the write
// again. The key is bound to the item type, the caller's outlet and the payload.
func (e *Engine) keyed(ctx context.Context, c Caller, it BatchItem, effect func(tx pgx.Tx) (string, error)) (string, error) {
	out, err := e.keyedOutcome(ctx, c, it, func(tx pgx.Tx) (receiptOutcome, error) {
		id, err := effect(tx)
		return receiptOutcome{OrderID: id}, err
	})
	return out.OrderID, err
}

// keyedOutcome is keyed for effects that return more than an order id.
func (e *Engine) keyedOutcome(ctx context.Context, c Caller, it BatchItem, effect func(tx pgx.Tx) (receiptOutcome, error)) (receiptOutcome, error) {
	run := e.Receipts
	if run == nil {
		run = func(_ context.Context, _ service.ReceiptClaim, f service.ReceiptEffect) (json.RawMessage, bool, error) {
			out, err := f(nil)
			return out, false, err
		}
	}
	raw, _, err := run(ctx, service.ReceiptClaim{
		Key: it.IdempotencyKey, OpType: it.Type, Scope: c.OutletID, Payload: it.Payload,
	}, func(tx pgx.Tx) (json.RawMessage, error) {
		out, err := effect(tx)
		if err != nil {
			return nil, err
		}
		return json.Marshal(out)
	})
	if err != nil {
		return receiptOutcome{}, err
	}
	var out receiptOutcome
	if err := json.Unmarshal(raw, &out); err != nil {
		return receiptOutcome{}, err
	}
	return out, nil
}

// replay is the already-applied probe shared by the attribution and offline-cap
// refusals: an item whose key already landed returns the first attempt's result. A
// failed probe is a retryable error, never a refusal.
func (e *Engine) replay(ctx context.Context, c Caller, it BatchItem, r ItemResult, fail func(error) ItemResult) (ItemResult, bool) {
	id, status, refundState, applied, aerr := e.alreadyApplied(ctx, c, it)
	if aerr != nil {
		return fail(aerr), true
	}
	if !applied {
		return r, false
	}
	r.Status, r.OrderID, r.RefundState = status, id, refundState
	return r, true
}

// decodeEnvelope returns the item's envelope, or the zero value when absent or
// unparseable (attribute has already refused unparseable ones).
func decodeEnvelope(it BatchItem) Envelope {
	var env Envelope
	if len(it.Envelope) > 0 {
		_ = json.Unmarshal(it.Envelope, &env)
	}
	return env
}

// Keep the refund mutation boundary injectable for isolated authorization tests.
func (e *Engine) processOneWithRefund(ctx context.Context, c Caller, it BatchItem, refund refundFunc) ItemResult {
	return e.processOneWithSeq(ctx, c, it, refund, e.Orders.CreateOrderSeq)
}

// processOneWithCommands is processOneWithSeq for seams that know nothing of the stock
// counter (the command-boundary tests); their sales carry no per-item counter.
func (e *Engine) processOneWithCommands(ctx context.Context, c Caller, it BatchItem,
	refund refundFunc,
	createOrder func(context.Context, service.CreateOrderInput) (string, bool, bool, error),
) ItemResult {
	var withSeq func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error)
	if createOrder != nil {
		withSeq = func(ctx context.Context, in service.CreateOrderInput) (service.CreateOrderResult, error) {
			id, dup, warn, err := createOrder(ctx, in)
			return service.CreateOrderResult{OrderID: id, Duplicate: dup, StockWarning: warn}, err
		}
	}
	return e.processOneWithSeq(ctx, c, it, refund, withSeq)
}

func (e *Engine) processOneWithSeq(ctx context.Context, c Caller, it BatchItem,
	refund refundFunc,
	createOrder func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error),
) ItemResult {
	r := ItemResult{IdempotencyKey: it.IdempotencyKey}
	fail := func(err error) ItemResult {
		out := classifyItemError(err)
		if out.Sanitized {
			// Raw text can carry database detail; keep it server-side (no payload).
			slog.Error("sync batch item failed", "type", it.Type, "idempotencyKey", it.IdempotencyKey, "code", out.Code, "err", err)
		}
		retryable := out.Retryable
		r.Status, r.Error, r.Code, r.Retryable = "error", out.Message, string(out.Code), &retryable
		return r
	}

	// Attribution first (A04): from here on c is the capture-time identity, never the
	// flush-time request headers. A refused item has no effect and stores no receipt.
	c, err := e.attribute(ctx, c, it)
	if err != nil {
		if code, _ := apperr.CodeOf(err); code == apperr.ActorMismatch {
			if res, replayed := e.replay(ctx, c, it, r, fail); replayed {
				return res
			}
		}
		return fail(err)
	}

	// Offline cap (A05): an item captured more than 12 h after the tablet's last online
	// contact is refused into review. The replay probe runs first, so a key that already
	// landed replays as ok/duplicate and never becomes a review item. Never dropped.
	env := decodeEnvelope(it)
	if refuse, warn := capVerdict(it.Type, env, e.now(), e.ContactKey); refuse {
		err := apperr.New(apperr.OfflineExpired, offlineExpiredMessage)
		if res, replayed := e.replay(ctx, c, it, r, fail); replayed {
			return res
		}
		return fail(err)
	} else if warn != "" {
		slog.Warn(warn, "type", it.Type, "idempotencyKey", it.IdempotencyKey, "deviceId", env.DeviceID)
	}

	switch it.Type {
	case "order":
		var p orderPayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.Wrap(apperr.Rejected, err))
		}
		shiftID, err := e.payloadShift(ctx, c, it, p.ShiftID)
		if err != nil {
			return fail(err)
		}
		evalTime, skew := boundSaleTime(readEvidence(env, e.now(), e.ContactKey), p.ClientCreatedAt, e.now())
		if skew {
			slog.Warn("sale clock disagrees with offline evidence; promo/loyalty evaluated at a bounded time",
				"idempotencyKey", it.IdempotencyKey, "deviceId", env.DeviceID)
		}
		in := service.CreateOrderInput{
			IdempotencyKey:    it.IdempotencyKey,
			OrderUUID:         p.OrderUUID,
			OrderNumber:       p.OrderNumber,
			DeviceID:          p.DeviceID,
			OutletID:          c.OutletID,
			CashierID:         c.UserID,
			CashierName:       c.DisplayName,
			SalesmanID:        p.SalesmanID,
			SalesmanName:      p.SalesmanName,
			CustomerID:        p.CustomerID,
			CustomerName:      p.CustomerName,
			Items:             p.Items,
			PaymentMethod:     p.PaymentMethod,
			AmountPaid:        p.AmountPaid,
			ManualKind:        service.DiscountKind(p.DiscountType),
			ManualValue:       p.DiscountValue,
			Surcharge:         p.SurchargeValue,
			SurchargeKind:     service.DiscountKind(p.SurchargeType),
			DiscountCode:      p.DiscountCode,
			PromotionID:       p.PromotionID,
			PromotionIDs:      p.PromotionIDs,
			DiscountCodes:     p.DiscountCodes,
			DiscountLabel:     p.DiscountLabel,
			DiscountBreakdown: p.DiscountBreakdown,
			QuotedTotal:       p.QuotedTotal,
			ReceiptSnapshot:   p.ReceiptSnapshot,
			PointsRedeemed:    p.PointsRedeemed,
			Notes:             p.Notes,
			ShiftID:           shiftID,
			ClientCreated:     p.ClientCreatedAt,
			EvalTime:          evalTime,
			ClockSkew:         skew,
			Offline:           true,
		}
		res, err := createOrder(ctx, in)
		if err != nil {
			return fail(err)
		}
		r.OrderID, r.StockWarning = res.OrderID, res.StockWarning
		if res.Duplicate {
			r.Status = "duplicate" // a replay moved nothing: no counter value
		} else {
			r.Status = "ok"
			if res.StockSeq != nil && !e.StockSeqOff {
				// c is the ATTRIBUTED identity here; processBatch drops the value
				// unless that outlet is also the batch caller's.
				seq := *res.StockSeq
				r.StockSeq, r.attributedOutlet = &seq, c.OutletID
			}
		}
		return r
	case "refund":
		if !c.CanRefund {
			// A06: a refund that already committed replays as ok even if the
			// permission was removed since (M3 rule); only an uncommitted key is
			// forbidden. A failed probe is a retryable server error, never a review item.
			id, _, state, applied, aerr := e.alreadyApplied(ctx, c, it)
			if aerr != nil {
				return fail(aerr)
			}
			if applied {
				r.Status, r.OrderID, r.RefundState = "ok", id, state
				return r
			}
			return fail(apperr.New(apperr.Forbidden, "Sinkronisasi refund belum selesai: izin refund pada permintaan ini tidak mencukupi. Operasi tetap tersimpan dan belum terselesaikan. Jika uang sudah dikembalikan, jangan bayar ulang."))
		}
		var p refundPayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.Wrap(apperr.Rejected, err))
		}
		out, err := e.keyedOutcome(ctx, c, it, func(tx pgx.Tx) (receiptOutcome, error) {
			orderID, rerr := e.refundSaleID(ctx, tx, c.OutletID, p.OrderID, p.SaleOrderUUID, p.DeviceID)
			if rerr != nil {
				return receiptOutcome{}, rerr
			}
			// ShiftID is only ever a shift attribute() found at the attributed outlet.
			res, rerr := refund(ctx, tx, p.input(c, orderID))
			return receiptOutcome{OrderID: orderID, RefundState: res.RefundState}, rerr
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID, r.RefundState = "ok", out.OrderID, out.RefundState
		return r
	case "shift_open":
		p, err := service.DecodeOpenShift(bytes.NewReader(it.Payload))
		if err != nil {
			return fail(err)
		}
		id, err := e.keyed(ctx, c, it, func(tx pgx.Tx) (string, error) {
			return e.Orders.OpenShiftTx(ctx, tx, service.OpenShiftInput{
				OutletID: c.OutletID, OutletName: p.OutletName,
				CashierID: c.UserID, CashierName: c.DisplayName,
				StartingCash: p.StartingCash,
			})
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
		return r
	case "shift_close":
		p, err := service.DecodeCloseShift(bytes.NewReader(it.Payload), true)
		if err != nil {
			return fail(err)
		}
		id, err := e.keyed(ctx, c, it, func(tx pgx.Tx) (string, error) {
			return p.ShiftID, e.Orders.CloseShiftTx(ctx, tx, c.OutletID, p.ShiftID, p.ClosingCash, p.CountedByMethod)
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
		return r
	case "cash_flow":
		var p struct {
			ShiftID     string  `json:"shiftId"`
			Type        string  `json:"type"`
			Amount      float64 `json:"amount"`
			Description string  `json:"description"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.Wrap(apperr.Rejected, err))
		}
		flowShift, err := e.payloadShift(ctx, c, it, p.ShiftID)
		if err != nil {
			return fail(err)
		}
		id, err := e.keyed(ctx, c, it, func(tx pgx.Tx) (string, error) {
			return e.Orders.AddCashFlowTx(ctx, tx, service.CashFlowInput{
				OutletID: c.OutletID, ShiftID: flowShift, Type: p.Type,
				Amount: p.Amount, Description: p.Description,
				CashierID: c.UserID, CashierName: c.DisplayName,
			})
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
		return r
	case "customer_create":
		var p struct {
			CustomerID string `json:"customerId"`
			Name       string `json:"name"`
			Phone      string `json:"phone"`
			Email      string `json:"email"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.Wrap(apperr.Rejected, err))
		}
		id, err := e.keyed(ctx, c, it, func(tx pgx.Tx) (string, error) {
			return e.Orders.CreateCustomerTx(ctx, tx, service.CreateCustomerInput{
				ID: p.CustomerID, Name: p.Name, Phone: p.Phone, Email: p.Email,
			})
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
		return r
	case "transfer_receive":
		var p transferReceivePayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.New(apperr.Rejected, "payload tidak valid"))
		}
		// Replay first: a receipt that already landed under this key returns ok before any
		// grant or authority check, so it keeps replaying after the grant expired, the PIN
		// was re-set or the approver was demoted.
		if res, replayed := e.replay(ctx, c, it, r, fail); replayed {
			if res.Status == "ok" {
				e.fillTransfer(ctx, &res)
			}
			return res
		}
		// Every refusal below is forbidden: non-retryable, goes to review, never dropped.
		if p.ApprovalGrantID == "" {
			return fail(apperr.New(apperr.Forbidden, "Persetujuan online diperlukan"))
		}
		items := make([]write.TransferReceiveItem, len(p.Items))
		for i, pi := range p.Items {
			items[i] = write.TransferReceiveItem{
				ProductID:   pi.ProductID,
				VariantSize: pi.VariantSize,
				ReceivedQty: pi.ReceivedQty,
			}
		}
		if err := e.Write.ReceiveTransfer(ctx, p.TransferID,
			write.TransferReceive{Items: items, DiscrepancyReason: p.DiscrepancyReason},
			write.ReceiveMeta{ReceivedVia: "pos", IdempotencyKey: it.IdempotencyKey,
				Approval: &write.ApprovalBinding{
					GrantID: p.ApprovalGrantID, OutletID: c.OutletID, RequesterID: c.UserID,
					ReceiptKey:  it.IdempotencyKey,
					Fingerprint: write.ReceiveFingerprint(p.TransferID, items, p.DiscrepancyReason),
					DeviceID:    env.DeviceID,
				}},
		); err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", p.TransferID
		// Soft-fail: the receive succeeded; we just couldn't read it back.
		e.fillTransfer(ctx, &r)
		return r
	}
	return fail(apperr.New(apperr.Rejected, "unknown batch item type: "+it.Type))
}

// fillTransfer adds the completed transfer snapshot and tanda terima number to an ok
// transfer_receive result (r.OrderID is the transfer id). Soft-fail: when the read
// fails the POS onReceiveAccepted prompt just won't appear (the reprint button still works).
func (e *Engine) fillTransfer(ctx context.Context, r *ItemResult) {
	tr, terr := e.Read.Transfer(ctx, r.OrderID)
	if terr != nil {
		return
	}
	r.Transfer = &tr
	if tr.TandaTerimaNo.IsSpecified() && !tr.TandaTerimaNo.IsNull() {
		v, _ := tr.TandaTerimaNo.Get()
		r.TandaTerimaNo = v
	}
}

// approverAllowed reports whether a user with the given role may approve a POS
// transfer receive. Admins are always allowed; others must be in approverRoles.
func approverAllowed(role string, approverRoles []string) bool {
	return write.ApproverAllowed(role, approverRoles)
}

// receiveScope: see write.ReceiveScope (shared with the in-transaction re-check).
func receiveScope(callerOutlet, destOutlet, approverRole, approverOutlet string) string {
	return write.ReceiveScope(callerOutlet, destOutlet, approverRole, approverOutlet)
}

type transferReceivePayload struct {
	TransferID string `json:"transferId"`
	Items      []struct {
		ProductID   string `json:"productId"`
		VariantSize string `json:"variantSize"`
		ReceivedQty int    `json:"receivedQty"`
	} `json:"items"`
	DiscrepancyReason string `json:"discrepancyReason"`
	ApproverUserID    string `json:"approverUserId"`
	// ApprovalGrantID is the single-use online step-up grant (A08). There is no PIN
	// field: a legacy item carrying one is decoded without it and refused for lack of a grant.
	ApprovalGrantID string `json:"approvalGrantId"`
}

type orderPayload struct {
	OrderUUID         string              `json:"orderUuid"`
	OrderNumber       string              `json:"orderNumber"`
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
	SurchargeValue    float64             `json:"surchargeValue"`
	SurchargeType     string              `json:"surchargeType"`
	DiscountCode      string              `json:"discountCode"`
	PromotionID       string              `json:"promotionId"`
	PromotionIDs      []string            `json:"promotionIds"`
	DiscountCodes     []string            `json:"discountCodes"`
	DiscountLabel     string              `json:"discountLabel"`
	DiscountBreakdown json.RawMessage     `json:"discountBreakdown"`
	PointsRedeemed    int                 `json:"pointsRedeemed"`
	Notes             string              `json:"notes"`
	ShiftID           string              `json:"shiftId"`
	ClientCreatedAt   *time.Time          `json:"clientCreatedAt"`
	QuotedTotal       *float64            `json:"quotedTotal"`     // A10: absent on legacy outbox items
	ReceiptSnapshot   json.RawMessage     `json:"receiptSnapshot"` // A10
}
