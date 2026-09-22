// Package sync implements the offline POS contract (plan §5, §5a): the
// content-version sync wall, delta pull of reference data, and idempotent
// outbox batch processing.
package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

type Engine struct {
	Pool   *pgxpool.Pool
	Read   *read.Repo
	Orders *service.OrderService
	Write  *write.Repo
}

func New(p *pgxpool.Pool, rd *read.Repo, os *service.OrderService, wr *write.Repo) *Engine {
	return &Engine{Pool: p, Read: rd, Orders: os, Write: wr}
}

type VersionInfo struct {
	Version  int64           `json:"version"`
	Manifest json.RawMessage `json:"dataManifest"`
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
	var code, name *string
	if e := e.Pool.QueryRow(ctx, `SELECT code, name FROM outlets WHERE id=$1`, outletID).Scan(&code, &name); e == nil {
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
	if b.Customers, err = e.Read.RecentCustomersForOutlet(ctx, sc.OutletID, 90, 1000); err != nil {
		return b, err
	}
	if b.Promotions, _, err = e.Read.Promotions(ctx); err != nil {
		return b, err
	}
	if b.DiscountCodes, _, err = e.Read.DiscountCodes(ctx); err != nil {
		return b, err
	}
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
	// Scoped receive approvers (outlet pulls only; transfers now served by the inbound poll).
	if outletID != "" {
		if b.ReceiveApprovers, err = e.Read.ReceiveApprovingUsers(ctx, outletID); err != nil {
			return b, err
		}
	}
	return b, nil
}

// ── Outbox batch ──────────────────────────────────────────

type BatchItem struct {
	Type           string          `json:"type"` // order|refund|shift_open|shift_close|cash_flow
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
}

type ItemResult struct {
	IdempotencyKey string        `json:"idempotencyKey"`
	Status         string        `json:"status"` // ok|duplicate|error
	OrderID        string        `json:"orderId,omitempty"`
	StockWarning   bool          `json:"stockWarning,omitempty"`
	Error          string        `json:"error,omitempty"`
	TandaTerimaNo  string        `json:"tandaTerimaNo,omitempty"`
	Transfer       *api.Transfer `json:"transfer,omitempty"`
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
	// Server-derived from authenticated request claims; never from a batch body.
	CanRefund bool `json:"-"`
}

// ProcessBatch flushes outbox items in order, one at a time, each idempotent.
// A failed item does not abort the batch — POS retries it next flush.
func (e *Engine) ProcessBatch(ctx context.Context, c Caller, items []BatchItem) (BatchResult, error) {
	return processBatch(ctx, c, items, e.processOne, e.Version)
}

func processBatch(ctx context.Context, c Caller, items []BatchItem,
	process func(context.Context, Caller, BatchItem) ItemResult,
	version func(context.Context, string) (VersionInfo, error),
) (BatchResult, error) {
	out := BatchResult{Results: make([]ItemResult, 0, len(items))}
	for _, it := range items {
		res := process(ctx, c, it)
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
	return e.processOneWithRefund(ctx, c, it, e.Orders.Refund)
}

// Keep the refund mutation boundary injectable for isolated authorization tests.
func (e *Engine) processOneWithRefund(ctx context.Context, c Caller, it BatchItem, refund func(context.Context, string, string, string) error) ItemResult {
	return e.processOneWithCommands(ctx, c, it, refund, e.Orders.CreateOrder)
}

func (e *Engine) processOneWithCommands(ctx context.Context, c Caller, it BatchItem,
	refund func(context.Context, string, string, string) error,
	createOrder func(context.Context, service.CreateOrderInput) (string, bool, bool, error),
) ItemResult {
	r := ItemResult{IdempotencyKey: it.IdempotencyKey}
	fail := func(err error) ItemResult { r.Status = "error"; r.Error = err.Error(); return r }

	switch it.Type {
	case "order":
		var p orderPayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
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
			PointsRedeemed:    p.PointsRedeemed,
			Notes:             p.Notes,
			ShiftID:           p.ShiftID,
			ClientCreated:     p.ClientCreatedAt,
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
			return fail(errors.New("Sinkronisasi refund belum selesai: izin refund pada permintaan ini tidak mencukupi. Operasi tetap tersimpan dan belum terselesaikan. Jika uang sudah dikembalikan, jangan bayar ulang."))
		}
		var p struct {
			OrderID string `json:"orderId"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
		}
		if err := refund(ctx, c.OutletID, p.OrderID, p.Reason); err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", p.OrderID
		return r
	case "shift_open":
		p, err := service.DecodeOpenShift(bytes.NewReader(it.Payload))
		if err != nil {
			return fail(err)
		}
		id, err := e.Orders.OpenShift(ctx, service.OpenShiftInput{
			OutletID: c.OutletID, OutletName: p.OutletName,
			CashierID: c.UserID, CashierName: c.DisplayName,
			StartingCash: p.StartingCash,
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
		if err := e.Orders.CloseShift(ctx, c.OutletID, p.ShiftID, p.ClosingCash, p.CountedByMethod); err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", p.ShiftID
		return r
	case "cash_flow":
		var p struct {
			ShiftID     string  `json:"shiftId"`
			Type        string  `json:"type"`
			Amount      float64 `json:"amount"`
			Description string  `json:"description"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
		}
		id, err := e.Orders.AddCashFlow(ctx, service.CashFlowInput{
			OutletID: c.OutletID, ShiftID: p.ShiftID, Type: p.Type,
			Amount: p.Amount, Description: p.Description,
			CashierID: c.UserID, CashierName: c.DisplayName,
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
			return fail(err)
		}
		id, err := e.Orders.CreateCustomer(ctx, service.CreateCustomerInput{
			ID: p.CustomerID, Name: p.Name, Phone: p.Phone, Email: p.Email,
		})
		if err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", id
		return r
	case "transfer_receive":
		var p transferReceivePayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(errors.New("payload tidak valid"))
		}
		appr, err := e.Read.UserAuth(ctx, p.ApproverUserID)
		if err != nil {
			return fail(errors.New("penyetuju tidak ditemukan"))
		}
		roles, _ := e.Read.ReceiveApproverRoles(ctx)
		if !approverAllowed(appr.Role, roles) {
			return fail(errors.New("tidak berwenang"))
		}
		if appr.ReceivePinHash == "" {
			return fail(errors.New("PIN belum disetel"))
		}
		ok, _ := auth.VerifyPassword(p.Pin, appr.ReceivePinHash)
		if !ok {
			return fail(errors.New("PIN salah"))
		}
		// Scope re-validation (defense-in-depth; the on-device bundle scoping is not a server control):
		// the receive must target THIS device's outlet, and the approver must belong to that outlet (or be an admin).
		destOutlet, err := e.Read.TransferDestOutlet(ctx, p.TransferID)
		if err != nil {
			return fail(errors.New("transfer tidak ditemukan"))
		}
		if msg := receiveScope(c.OutletID, destOutlet, appr.Role, appr.OutletID); msg != "" {
			return fail(errors.New(msg))
		}
		items := make([]write.TransferReceiveItem, len(p.Items))
		for i, it := range p.Items {
			items[i] = write.TransferReceiveItem{
				ProductID:   it.ProductID,
				VariantSize: it.VariantSize,
				ReceivedQty: it.ReceivedQty,
			}
		}
		if err := e.Write.ReceiveTransfer(ctx, p.TransferID,
			write.TransferReceive{Items: items, DiscrepancyReason: p.DiscrepancyReason},
			write.ReceiveMeta{ReceivedBy: p.ApproverUserID, ReceivedVia: "pos", IdempotencyKey: it.IdempotencyKey},
		); err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", p.TransferID
		// Soft-fail: receive succeeded; we just couldn't read it back.
		// The POS onReceiveAccepted prompt won't appear for this transfer —
		// acceptable (the reprint button still works if the cashier opens the
		// completed detail manually).
		tr, terr := e.Read.Transfer(ctx, p.TransferID)
		if terr == nil {
			r.Transfer = &tr
			if tr.TandaTerimaNo.IsSpecified() && !tr.TandaTerimaNo.IsNull() {
				v, _ := tr.TandaTerimaNo.Get()
				r.TandaTerimaNo = v
			}
		}
		return r
	}
	return fail(errors.New("unknown batch item type: " + it.Type))
}

// approverAllowed reports whether a user with the given role may approve a POS
// transfer receive. Admins are always allowed; others must be in approverRoles.
func approverAllowed(role string, approverRoles []string) bool {
	if role == "admin" {
		return true
	}
	for _, r := range approverRoles {
		if r == role {
			return true
		}
	}
	return false
}

// receiveScope checks that (a) the transfer's destination outlet matches the
// caller's outlet, and (b) the approver is either an admin or assigned to that
// same outlet. Returns "" on success, or an Indonesian error string on failure.
// destOutlet == "" means the transfer targets a warehouse (not an outlet).
func receiveScope(callerOutlet, destOutlet, approverRole, approverOutlet string) string {
	if destOutlet == "" || destOutlet != callerOutlet {
		return "transfer bukan untuk outlet ini"
	}
	if approverRole != "admin" && approverOutlet != destOutlet {
		return "tidak berwenang"
	}
	return ""
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
	Pin               string `json:"pin"`
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
}
