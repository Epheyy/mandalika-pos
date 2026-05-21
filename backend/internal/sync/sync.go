// Package sync implements the offline POS contract (plan §5, §5a): the
// content-version sync wall, delta pull of reference data, and idempotent
// outbox batch processing.
package sync

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
)

type Engine struct {
	Pool   *pgxpool.Pool
	Read   *read.Repo
	Orders *service.OrderService
}

func New(p *pgxpool.Pool, rd *read.Repo, os *service.OrderService) *Engine {
	return &Engine{Pool: p, Read: rd, Orders: os}
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
}

func (e *Engine) Pull(ctx context.Context, sc read.Scope, outletID string) (PullBundle, error) {
	var b PullBundle
	vi, err := e.Version(ctx, outletID)
	if err != nil {
		return b, err
	}
	b.Version = vi.Version
	// Outlet code → POS so it can build {OUTLET}-{DEV}{SEQ} order numbers offline.
	var code *string
	if e := e.Pool.QueryRow(ctx, `SELECT code FROM outlets WHERE id=$1`, outletID).Scan(&code); e == nil && code != nil {
		b.OutletCode = *code
	}
	if b.Products, _, err = e.Read.Products(ctx, 1, 100000); err != nil {
		return b, err
	}
	if b.Categories, _, err = e.Read.Categories(ctx); err != nil {
		return b, err
	}
	if b.Bundles, _, err = e.Read.Bundles(ctx); err != nil {
		return b, err
	}
	if b.Customers, _, err = e.Read.Customers(ctx, 1, 100000); err != nil {
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
	return b, nil
}

// ── Outbox batch ──────────────────────────────────────────

type BatchItem struct {
	Type           string          `json:"type"` // order|refund|shift_open|shift_close|cash_flow
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
}

type ItemResult struct {
	IdempotencyKey string `json:"idempotencyKey"`
	Status         string `json:"status"` // ok|duplicate|error
	OrderID        string `json:"orderId,omitempty"`
	StockWarning   bool   `json:"stockWarning,omitempty"`
	Error          string `json:"error,omitempty"`
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
}

// ProcessBatch flushes outbox items in order, one at a time, each idempotent.
// A failed item does not abort the batch — POS retries it next flush.
func (e *Engine) ProcessBatch(ctx context.Context, c Caller, items []BatchItem) (BatchResult, error) {
	out := BatchResult{Results: make([]ItemResult, 0, len(items))}
	for _, it := range items {
		res := e.processOne(ctx, c, it)
		out.Results = append(out.Results, res)
		if res.Status != "error" {
			out.Processed++
		}
	}
	vi, err := e.Version(ctx, c.OutletID)
	if err != nil {
		return out, err
	}
	out.Version = vi.Version
	return out, nil
}

func (e *Engine) processOne(ctx context.Context, c Caller, it BatchItem) ItemResult {
	r := ItemResult{IdempotencyKey: it.IdempotencyKey}
	fail := func(err error) ItemResult { r.Status = "error"; r.Error = err.Error(); return r }

	switch it.Type {
	case "order":
		var p orderPayload
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
		}
		in := service.CreateOrderInput{
			IdempotencyKey: it.IdempotencyKey,
			OrderUUID:      p.OrderUUID,
			OrderNumber:    p.OrderNumber,
			DeviceID:       p.DeviceID,
			OutletID:       c.OutletID,
			CashierID:      c.UserID,
			CashierName:    c.DisplayName,
			SalesmanID:     p.SalesmanID,
			SalesmanName:   p.SalesmanName,
			CustomerID:     p.CustomerID,
			CustomerName:   p.CustomerName,
			Items:          p.Items,
			PaymentMethod:  p.PaymentMethod,
			AmountPaid:     p.AmountPaid,
			ManualKind:     service.DiscountKind(p.DiscountType),
			ManualValue:    p.DiscountValue,
			Surcharge:      p.SurchargeValue,
			SurchargeKind:  service.DiscountKind(p.SurchargeType),
			DiscountCode:   p.DiscountCode,
			PromotionID:    p.PromotionID,
			PointsRedeemed: p.PointsRedeemed,
			Notes:          p.Notes,
			ShiftID:        p.ShiftID,
			ClientCreated:  p.ClientCreatedAt,
			Offline:        true,
		}
		id, dup, warn, err := e.Orders.CreateOrder(ctx, in)
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
		var p struct {
			OrderID string `json:"orderId"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
		}
		if err := e.Orders.Refund(ctx, c.OutletID, p.OrderID, p.Reason); err != nil {
			return fail(err)
		}
		r.Status, r.OrderID = "ok", p.OrderID
		return r
	case "shift_open":
		var p struct {
			OutletName   string  `json:"outletName"`
			StartingCash float64 `json:"startingCash"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
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
		var p struct {
			ShiftID     string  `json:"shiftId"`
			ClosingCash float64 `json:"closingCash"`
		}
		if err := json.Unmarshal(it.Payload, &p); err != nil {
			return fail(err)
		}
		if err := e.Orders.CloseShift(ctx, c.OutletID, p.ShiftID, p.ClosingCash); err != nil {
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
	}
	return fail(errors.New("unknown batch item type: " + it.Type))
}

type orderPayload struct {
	OrderUUID       string              `json:"orderUuid"`
	OrderNumber     string              `json:"orderNumber"`
	DeviceID        string              `json:"deviceId"`
	SalesmanID      string              `json:"salesmanId"`
	SalesmanName    string              `json:"salesmanName"`
	CustomerID      string              `json:"customerId"`
	CustomerName    string              `json:"customerName"`
	Items           []service.OrderItem `json:"items"`
	PaymentMethod   string              `json:"paymentMethod"`
	AmountPaid      float64             `json:"amountPaid"`
	DiscountType    string              `json:"discountType"`
	DiscountValue   float64             `json:"discountValue"`
	SurchargeValue  float64             `json:"surchargeValue"`
	SurchargeType   string              `json:"surchargeType"`
	DiscountCode    string              `json:"discountCode"`
	PromotionID     string              `json:"promotionId"`
	PointsRedeemed  int                 `json:"pointsRedeemed"`
	Notes           string              `json:"notes"`
	ShiftID         string              `json:"shiftId"`
	ClientCreatedAt *time.Time          `json:"clientCreatedAt"`
}
