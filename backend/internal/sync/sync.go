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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
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
}

// saleResolver resolves a sale by order_uuid within one outlet. A missing sale must
// return service.ErrRefundOrderNotFound.
type saleResolver func(ctx context.Context, tx pgx.Tx, outletID, orderUUID string) (id, deviceID string, err error)

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

type VersionInfo struct {
	Version  int64           `json:"version"`
	Manifest json.RawMessage `json:"dataManifest"`
	// Contact is the signed online-contact proof, set by the handler when the request
	// carried a device id (A05). Absent otherwise (omitempty: old clients unaffected).
	Contact *ContactToken `json:"contact,omitempty"`
}

// Version returns the outlet content version, lazily seeding the row.
func (e *Engine) Version(ctx context.Context, outletID string) (VersionInfo, error) {
	var v VersionInfo
	err := e.Pool.QueryRow(ctx,
		`SELECT version, data_manifest FROM content_versions WHERE outlet_id=$1`,
		outletID).Scan(&v.Version, &v.Manifest)
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = e.Pool.Exec(ctx,
			`INSERT INTO content_versions (outlet_id) VALUES ($1)
			 ON CONFLICT DO NOTHING`, outletID)
		return VersionInfo{Version: 1, Manifest: json.RawMessage("{}")}, nil
	}
	return v, err
}

// PullBundle is the full reference snapshot POS swaps in on Resync. Sending the
// whole snapshot keeps the swap atomic and conflict-free (POS is read-only on
// reference data — plan §5a).
type PullBundle struct {
	Version           int64  `json:"version"`
	OutletCode        string `json:"outletCode"`
	OutletName        string `json:"outletName"`
	OutletTimezone    string `json:"outletTimezone,omitempty"`
	Products          any    `json:"products"`
	Categories        any    `json:"categories"`
	Bundles           any    `json:"bundles"`
	Customers         any    `json:"customers"`
	Promotions        any    `json:"promotions"`
	DiscountCodes     any    `json:"discountCodes"`
	LoyaltyConditions any    `json:"loyaltyConditions"`
	LoyaltySettings   any    `json:"loyaltySettings"`
	AppSettings       any    `json:"appSettings"`
	Users             any    `json:"users"`
	ReceiveApprovers  any    `json:"receiveApprovers"`
}

func (e *Engine) Pull(ctx context.Context, sc read.Scope, outletID string) (PullBundle, error) {
	var b PullBundle
	vi, err := e.Version(ctx, outletID)
	if err != nil {
		return b, err
	}
	b.Version = vi.Version
	// Outlet code → POS so it can build {OUTLET}-{DEV}{SEQ} order numbers offline.
	// Outlet name → POS so the recap/print read the active outlet, not a constant.
	// Outlet timezone -> POS so its promo twin gates hours/dates on the outlet clock (A28).
	var code, name, tz *string
	if e := e.Pool.QueryRow(ctx, `SELECT code, name, timezone FROM outlets WHERE id=$1`, outletID).Scan(&code, &name, &tz); e == nil {
		if tz != nil {
			b.OutletTimezone = *tz
		}
		if code != nil {
			b.OutletCode = *code
		}
		if name != nil {
			b.OutletName = *name
		}
	}
	// Outlet-scoped: POS receives this outlet's resolved stock/price, only products
	// available here, and only customer-sellable ones (sc.OutletID = cashier outlet).
	sc.SellableOnly = true
	if b.Products, _, err = e.Read.Products(ctx, sc, 1, 100000); err != nil {
		return b, err
	}
	if b.Categories, _, err = e.Read.Categories(ctx); err != nil {
		return b, err
	}
	if b.Bundles, _, err = e.Read.Bundles(ctx); err != nil {
		return b, err
	}
	// A30: the tablet no longer carries a browsable customer list. The field stays (empty)
	// so an old POS bundle parses; cashiers find customers by exact phone online.
	b.Customers = []api.Customer{}
	if b.Promotions, _, err = e.Read.Promotions(ctx); err != nil {
		return b, err
	}
	codes, _, err := e.Read.DiscountCodes(ctx)
	if err != nil {
		return b, err
	}
	// customerId stays (the POS wrong_customer rule needs it); the name is PII.
	b.DiscountCodes = read.WithoutCustomerNames(codes)
	if b.LoyaltyConditions, _, err = e.Read.LoyaltyConditions(ctx); err != nil {
		return b, err
	}
	if b.LoyaltySettings, err = e.Read.LoyaltySettings(ctx); err != nil {
		return b, err
	}
	if b.AppSettings, err = e.Read.AppSettings(ctx); err != nil {
		return b, err
	}
	// Staff list for the salesman picker (offline-capable; small table).
	if b.Users, _, err = e.Read.Users(ctx, 1, 100000); err != nil {
		return b, err
	}
	// A08: no PIN hash (and no approver list) is shipped to tablets any more. The field
	// stays, always empty, so older bundles still parse; approvers come online from
	// GET /sync/receive-approvers.
	b.ReceiveApprovers = []api.ReceiveApprover{}
	return b, nil
}

// ── Outbox batch ──────────────────────────────────────────

type BatchItem struct {
	Type           string          `json:"type"` // order|refund|shift_open|shift_close|cash_flow
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
	// Envelope is the raw capture-time identity (A04), absent for legacy clients.
	Envelope json.RawMessage `json:"envelope,omitempty"`
}

type ItemResult struct {
	IdempotencyKey string `json:"idempotencyKey"`
	Status         string `json:"status"` // ok|duplicate|error
	OrderID        string `json:"orderId,omitempty"`
	StockWarning   bool   `json:"stockWarning,omitempty"`
	Error          string `json:"error,omitempty"`
	// Code and Retryable are set exactly when Status is "error" (Retryable is a
	// pointer so false is still serialised). Clients must treat a missing or
	// unknown Code as the pre-contract behaviour (an older server omits both).
	Code          string        `json:"code,omitempty"`
	Retryable     *bool         `json:"retryable,omitempty"`
	TandaTerimaNo string        `json:"tandaTerimaNo,omitempty"`
	Transfer      *api.Transfer `json:"transfer,omitempty"`
}

type BatchResult struct {
	Processed int          `json:"processed"`
	Results   []ItemResult `json:"results"`
	Version   int64        `json:"version"`
}

// Identity from the authenticated caller (never trusted from payload).
type Caller struct {
	OutletID    string
	UserID      string
	DisplayName string
	// Role and HomeOutletID come from the users row (not the request): the outlet a
	// non-admin may be attributed to is only ever their stored outlet (A04).
	Role         string `json:"-"`
	HomeOutletID string `json:"-"`
	// Server-derived from authenticated request claims; never from a batch body.
	CanRefund bool `json:"-"`
	// EnvelopeShiftID is set by attribute() only when the envelope's shift row exists
	// at the attributed outlet (open or closed); unknown, non-uuid or absent -> "".
	// Never taken from the request: a dangling id would hit the orders FK (23503).
	EnvelopeShiftID string `json:"-"`
}

// ProcessBatch flushes outbox items in order, one at a time, each idempotent.
// A failed item does not abort the batch — POS retries it next flush.
func (e *Engine) ProcessBatch(ctx context.Context, c Caller, items []BatchItem) (BatchResult, error) {
	return processBatch(ctx, c, items, e.processOne, e.Version)
}

// closeHeldMessage is returned for a shift_close held back because an earlier item
// in the same batch failed retryably (its effect must land in the close snapshot).
const closeHeldMessage = "Tutup shift ditunda: ada transaksi sebelumnya yang belum tersimpan, akan dicoba ulang otomatis."

// openHeldMessage is the shift_open counterpart: a new shift must not open while the old
// one is being held open, or it would be refused as a second open shift.
const openHeldMessage = "Buka shift ditunda: ada transaksi sebelumnya yang belum tersimpan, akan dicoba ulang otomatis."

// heldMessage is the hold text for the item types that wait behind an earlier retryable
// failure: shift_close (so its snapshot stays complete) and shift_open (so a new shift
// is not refused as a second open one while the old close is held). Sales and refunds
// are never held.
func heldMessage(itemType string) string {
	switch itemType {
	case "shift_close":
		return closeHeldMessage
	case "shift_open":
		return openHeldMessage
	}
	return ""
}

func processBatch(ctx context.Context, c Caller, items []BatchItem,
	process func(context.Context, Caller, BatchItem) ItemResult,
	version func(context.Context, string) (VersionInfo, error),
) (BatchResult, error) {
	out := BatchResult{Results: make([]ItemResult, 0, len(items))}
	// A06/M3: the close snapshot is never recomputed, so a shift_close must not commit
	// while an earlier item of this batch (a sale or refund the snapshot should count)
	// failed retryably. Permanent refusals are review items the server never counts,
	// so they do not hold it. Any earlier retryable failure holds (conservative; the
	// POS sends FIFO and resends the same keys, so the held close just runs next flush).
	earlierRetryable := false
	for _, it := range items {
		var res ItemResult
		if msg := heldMessage(it.Type); msg != "" && earlierRetryable {
			// No receipt claimed, no effect: the same key runs normally on retry.
			retryable := true
			res = ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "error", Error: msg,
				Code: string(apperr.Busy), Retryable: &retryable}
		} else {
			res = process(ctx, c, it)
		}
		if res.Status == "error" && res.Retryable != nil && *res.Retryable {
			earlierRetryable = true
		}
		out.Results = append(out.Results, res)
		if res.Status != "error" {
			out.Processed++
		}
	}
	vi, err := version(ctx, c.OutletID)
	if err != nil {
		return out, err
	}
	out.Version = vi.Version
	return out, nil
}

func (e *Engine) processOne(ctx context.Context, c Caller, it BatchItem) ItemResult {
	return e.processOneWithRefund(ctx, c, it, e.Orders.RefundTx)
}

// refundFunc runs a refund inside the transaction that also holds the item's
// operation receipt.
type refundFunc func(ctx context.Context, tx pgx.Tx, in service.RefundInput) error

// receiptOutcome is the stored result of a keyed write. Every type replays as
// status "ok" with the same orderId the first attempt returned.
type receiptOutcome struct {
	OrderID string `json:"orderId"`
}

// keyed runs effect exactly once for it.IdempotencyKey (A11): a retry after a lost
// response replays the first attempt's orderId instead of applying the write
// again. The key is bound to the item type, the caller's outlet and the payload.
func (e *Engine) keyed(ctx context.Context, c Caller, it BatchItem, effect func(tx pgx.Tx) (string, error)) (string, error) {
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
		id, err := effect(tx)
		if err != nil {
			return nil, err
		}
		return json.Marshal(receiptOutcome{OrderID: id})
	})
	if err != nil {
		return "", err
	}
	var out receiptOutcome
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	return out.OrderID, nil
}

// replay is the already-applied probe shared by the attribution and offline-cap
// refusals: an item whose key already landed returns the first attempt's result. A
// failed probe is a retryable error, never a refusal.
func (e *Engine) replay(ctx context.Context, c Caller, it BatchItem, r ItemResult, fail func(error) ItemResult) (ItemResult, bool) {
	id, status, applied, aerr := e.alreadyApplied(ctx, c, it)
	if aerr != nil {
		return fail(aerr), true
	}
	if !applied {
		return r, false
	}
	r.Status, r.OrderID = status, id
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
	return e.processOneWithCommands(ctx, c, it, refund, e.Orders.CreateOrder)
}

func (e *Engine) processOneWithCommands(ctx context.Context, c Caller, it BatchItem,
	refund refundFunc,
	createOrder func(context.Context, service.CreateOrderInput) (string, bool, bool, error),
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
		id, dup, warn, err := createOrder(ctx, in)
		if err != nil {
			return fail(err)
		}
		r.OrderID, r.StockWarning = id, warn
		if dup {
			r.Status = "duplicate"
		} else {
			r.Status = "ok"
		}
		return r
	case "refund":
		if !c.CanRefund {
			// A06: a refund that already committed replays as ok even if the
			// permission was removed since (M3 rule); only an uncommitted key is
			// forbidden. A failed probe is a retryable server error, never a review item.
			id, _, applied, aerr := e.alreadyApplied(ctx, c, it)
			if aerr != nil {
				return fail(aerr)
			}
			if applied {
				r.Status, r.OrderID = "ok", id
				return r
			}
			return fail(apperr.New(apperr.Forbidden, "Sinkronisasi refund belum selesai: izin refund pada permintaan ini tidak mencukupi. Operasi tetap tersimpan dan belum terselesaikan. Jika uang sudah dikembalikan, jangan bayar ulang."))
		}
		var p struct {
			OrderID       string `json:"orderId"`
			Reason        string `json:"reason"`
			SaleOrderUUID string `json:"saleOrderUuid"`
			DeviceID      string `json:"deviceId"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(apperr.Wrap(apperr.Rejected, err))
		}
		id, err := e.keyed(ctx, c, it, func(tx pgx.Tx) (string, error) {
			orderID, rerr := e.refundSaleID(ctx, tx, c.OutletID, p.OrderID, p.SaleOrderUUID, p.DeviceID)
			if rerr != nil {
				return "", rerr
			}
			// ShiftID is only ever a shift attribute() found at the attributed outlet.
			return orderID, refund(ctx, tx, service.RefundInput{
				OutletID: c.OutletID, OrderID: orderID, Reason: p.Reason,
				ShiftID: c.EnvelopeShiftID, UserID: c.UserID, UserName: c.DisplayName,
				Channel: "sync",
			})
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
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
