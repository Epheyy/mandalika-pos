package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNoItems     = errors.New("order has no items")
	ErrNoOutlet    = errors.New("order requires an outlet")
	ErrOrderClosed = errors.New("order not refundable")
)

// OrderItem is one cart line submitted by the client.
type OrderItem struct {
	ProductID   string  `json:"productId"`
	ProductName string  `json:"productName"`
	VariantSize string  `json:"variantSize"`
	Price       float64 `json:"price"`
	Quantity    int     `json:"quantity"`
	Subtotal    float64 `json:"subtotal"`
	IsBundle    bool    `json:"isBundle"`
}

// CreateOrderInput is the resolved request. Outlet/cashier come from the JWT,
// never the payload. Offline=true (sync path) allows stock to go negative.
type CreateOrderInput struct {
	IdempotencyKey string
	OrderUUID      string
	DeviceID       string // optional (sync clients)
	OutletID       string
	CashierID      string
	CashierName    string
	SalesmanID     string
	SalesmanName   string
	CustomerID     string
	CustomerName   string
	Items          []OrderItem
	PaymentMethod  string
	AmountPaid     float64
	ManualKind     DiscountKind
	ManualValue    float64
	Surcharge      float64
	SurchargeKind  DiscountKind
	DiscountCode   string // promo code applied
	PromotionID    string // applied promotion id
	PointsRedeemed int    // loyalty points the customer spends on this order
	Notes          string
	ShiftID        string
	ClientCreated  *time.Time
	Offline        bool
}

type OrderService struct{ Pool *pgxpool.Pool }

func NewOrderService(p *pgxpool.Pool) *OrderService { return &OrderService{Pool: p} }

// CreateOrder runs the whole checkout in ONE transaction and is idempotent on
// IdempotencyKey: a replay (offline retry, two devices/outlets posting the same
// data) returns the canonical stored order and never double-inserts (plan §5).
// Returns the order id, whether it was a duplicate, and a stock warning flag.
func (s *OrderService) CreateOrder(ctx context.Context, in CreateOrderInput) (orderID string, dup bool, stockWarning bool, err error) {
	if len(in.Items) == 0 {
		return "", false, false, ErrNoItems
	}
	if in.OutletID == "" {
		return "", false, false, ErrNoOutlet
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", false, false, err
	}
	defer tx.Rollback(ctx)

	// Durable idempotency guard (Redis is the fast path in the handler).
	var existing string
	err = tx.QueryRow(ctx,
		`SELECT order_id FROM processed_keys WHERE idempotency_key=$1`, in.IdempotencyKey).
		Scan(&existing)
	if err == nil {
		return existing, true, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, false, fmt.Errorf("idempotency check: %w", err)
	}

	// Resolve promo spec server-side (authoritative value, not client-supplied).
	promo, promoCodeID, err := s.resolvePromo(ctx, tx, in.PromotionID, in.DiscountCode)
	if err != nil {
		return "", false, false, err
	}

	taxEnabled, taxRate, roundEnabled, roundType, err := loadAppSettings(ctx, tx)
	if err != nil {
		return "", false, false, err
	}
	loyEnabled, pointsPerK, redemptionRate, err := loadLoyalty(ctx, tx)
	if err != nil {
		return "", false, false, err
	}

	items := make([]LineItem, len(in.Items))
	for i, it := range in.Items {
		items[i] = LineItem{ProductID: it.ProductID, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal}
	}
	res := Compute(PricingInput{
		Items: items, ManualDiscount: in.ManualValue, ManualKind: in.ManualKind,
		Surcharge: in.Surcharge, SurchargeKind: in.SurchargeKind, Promo: promo,
		TaxEnabled: taxEnabled, TaxRate: taxRate,
		RoundingEnabled: roundEnabled, RoundingType: roundType,
		LoyaltyEnabled: loyEnabled, PointsPerK: pointsPerK,
		HasCustomer: in.CustomerID != "",
	})

	// Loyalty redemption (P1-E): authoritative rupiah value from
	// loyalty_settings.redemption_rate, clamped to the customer's available
	// points and to the order total (can't pay a negative bill).
	pointsRedeemed := 0
	redeemAmount := 0.0
	if in.PointsRedeemed > 0 && in.CustomerID != "" && loyEnabled && redemptionRate > 0 {
		var avail int
		if e := tx.QueryRow(ctx,
			`SELECT points FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&avail); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
		pointsRedeemed = in.PointsRedeemed
		if pointsRedeemed > avail {
			pointsRedeemed = avail
		}
		redeemAmount = float64(pointsRedeemed) * redemptionRate
		if redeemAmount > res.Total {
			redeemAmount = res.Total
			pointsRedeemed = int(res.Total / redemptionRate)
		}
	}
	finalTotal := res.Total - redeemAmount

	// Stock decrement under row lock (plan §9 :752-763, FOR UPDATE).
	for _, it := range in.Items {
		var vid string
		var stock int
		e := tx.QueryRow(ctx,
			`SELECT pv.id, pv.stock FROM product_variants pv
			   WHERE pv.product_id=$1 AND pv.size=$2 FOR UPDATE`,
			it.ProductID, it.VariantSize).Scan(&vid, &stock)
		if errors.Is(e, pgx.ErrNoRows) {
			continue // bundle component or deleted variant — skip, do not fail the sale
		}
		if e != nil {
			return "", false, false, fmt.Errorf("lock variant: %w", e)
		}
		next := stock - it.Quantity
		if next < 0 {
			if in.Offline {
				stockWarning = true // recorded, flagged for admin reconciliation
			} else {
				next = 0 // online zero-floor (legacy parity)
			}
		}
		if _, e := tx.Exec(ctx, `UPDATE product_variants SET stock=$1 WHERE id=$2`, next, vid); e != nil {
			return "", false, false, fmt.Errorf("decrement stock: %w", e)
		}
	}

	orderNumber, err := nextOrderNumber(ctx, tx, in.OutletID)
	if err != nil {
		return "", false, false, err
	}

	amountPaid := in.AmountPaid
	change := 0.0
	if in.PaymentMethod == "cash" {
		change = amountPaid - finalTotal
		if change < 0 {
			change = 0
		}
	} else {
		amountPaid = finalTotal
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO orders (
		  order_number, order_uuid, idempotency_key, device_id, outlet_id,
		  cashier_id, cashier_name, salesman_id, salesman_name,
		  customer_id, customer_name, subtotal, discount_amount, discount_type,
		  discount_value, discount_code, surcharge_type, surcharge_value,
		  surcharge_amount, tax_amount, total, payment_method, amount_paid,
		  change, status, notes, shift_id, client_created_at, quoted_total,
		  stock_warning, points_redeemed)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
		        $19,$20,$21,$22,$23,$24,'completed',$25,$26,$27,$28,$29,$30)
		RETURNING id`,
		orderNumber, in.OrderUUID, in.IdempotencyKey, nullUUID(in.DeviceID), in.OutletID,
		in.CashierID, in.CashierName, nullUUID(in.SalesmanID), nullStr(in.SalesmanName),
		nullUUID(in.CustomerID), nullStr(in.CustomerName),
		res.Subtotal, res.DiscountAmount, nullStr(string(in.ManualKind)),
		nullNum(in.ManualValue), nullStr(in.DiscountCode),
		nullStr(string(in.SurchargeKind)), nullNum(in.Surcharge), res.SurchargeAmount,
		res.TaxAmount, finalTotal, in.PaymentMethod, amountPaid, change,
		nullStr(in.Notes), nullUUID(in.ShiftID), in.ClientCreated, finalTotal,
		stockWarning, pointsRedeemed,
	).Scan(&orderID)
	if err != nil {
		return "", false, false, fmt.Errorf("insert order: %w", err)
	}

	for _, it := range in.Items {
		if _, e := tx.Exec(ctx, `
			INSERT INTO order_items (order_id, product_id, product_name,
			  variant_size, price, quantity, subtotal, is_bundle)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			orderID, it.ProductID, it.ProductName, it.VariantSize,
			it.Price, it.Quantity, it.Subtotal, it.IsBundle); e != nil {
			return "", false, false, fmt.Errorf("insert item: %w", e)
		}
	}

	// Customer loyalty update (plan §9 :767-773).
	if in.CustomerID != "" {
		if _, e := tx.Exec(ctx, `
			UPDATE customers SET total_spent=total_spent+$1, visit_count=visit_count+1,
			  last_visit=now(), points=points+$2-$4 WHERE id=$3`,
			finalTotal, res.EarnedPoints, in.CustomerID, pointsRedeemed); e != nil {
			return "", false, false, fmt.Errorf("update customer: %w", e)
		}
	}

	// Promo usage increment (plan §9 :776-784).
	if promoCodeID != "" {
		if _, e := tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count=usage_count+1 WHERE id=$1`,
			promoCodeID); e != nil {
			return "", false, false, fmt.Errorf("promo usage: %w", e)
		}
	}

	if _, e := tx.Exec(ctx,
		`INSERT INTO processed_keys (idempotency_key, order_id) VALUES ($1,$2)`,
		in.IdempotencyKey, orderID); e != nil {
		return "", false, false, fmt.Errorf("record idempotency: %w", e)
	}

	if e := tx.Commit(ctx); e != nil {
		return "", false, false, fmt.Errorf("commit: %w", e)
	}
	return orderID, false, stockWarning, nil
}

// Refund flips the order to refunded and restores stock (Orders.tsx:47-72).
// Idempotent: refunding an already-refunded order is a no-op.
func (s *OrderService) Refund(ctx context.Context, outletID, orderID, reason string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOrderClosed
	}
	if err != nil {
		return err
	}
	if status == "refunded" {
		return tx.Commit(ctx) // already refunded — idempotent
	}
	if _, err = tx.Exec(ctx,
		`UPDATE orders SET status='refunded', refund_reason=$1, refunded_at=now()
		   WHERE id=$2`, reason, orderID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx,
		`SELECT product_id, variant_size, quantity FROM order_items WHERE order_id=$1`,
		orderID)
	if err != nil {
		return err
	}
	type ri struct {
		pid, size string
		qty       int
	}
	var restock []ri
	for rows.Next() {
		var r ri
		if err := rows.Scan(&r.pid, &r.size, &r.qty); err != nil {
			rows.Close()
			return err
		}
		restock = append(restock, r)
	}
	rows.Close()
	for _, r := range restock {
		if _, err = tx.Exec(ctx,
			`UPDATE product_variants SET stock=stock+$1
			   WHERE product_id=$2 AND size=$3`, r.qty, r.pid, r.size); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// resolvePromo turns an applied promotion id and/or discount code into the
// authoritative PromoSpec. Returns the discount_codes row id for usage++.
func (s *OrderService) resolvePromo(ctx context.Context, tx pgx.Tx, promoID, code string) (*PromoSpec, string, error) {
	if promoID != "" {
		var kind string
		var value float64
		var ids []string
		err := tx.QueryRow(ctx,
			`SELECT type, value,
			   COALESCE(applicable_product_ids,'[]'::jsonb)
			   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
			Scan(&kind, &value, &ids)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", nil
		}
		if err != nil {
			return nil, "", fmt.Errorf("load promotion: %w", err)
		}
		return &PromoSpec{
			Kind: DiscountKind(kind), Value: value,
			ApplicableProductIDs: ids, IsBOGO: kind == "bogo",
		}, "", nil
	}
	if code != "" {
		var id, kind string
		var value float64
		err := tx.QueryRow(ctx,
			`SELECT id, type, value FROM discount_codes
			   WHERE code=$1 AND is_active=true`, code).Scan(&id, &kind, &value)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", nil
		}
		if err != nil {
			return nil, "", fmt.Errorf("load discount code: %w", err)
		}
		return &PromoSpec{Kind: DiscountKind(kind), Value: value}, id, nil
	}
	return nil, "", nil
}

func loadAppSettings(ctx context.Context, tx pgx.Tx) (bool, float64, bool, string, error) {
	var te, re bool
	var tr float64
	var rt string
	err := tx.QueryRow(ctx,
		`SELECT tax_enabled, tax_rate, rounding_enabled, rounding_type
		   FROM app_settings WHERE id=1`).Scan(&te, &tr, &re, &rt)
	return te, tr, re, rt, err
}

func loadLoyalty(ctx context.Context, tx pgx.Tx) (bool, float64, float64, error) {
	var en bool
	var ppk, rate float64
	err := tx.QueryRow(ctx,
		`SELECT enabled, points_per_thousand, redemption_rate
		   FROM loyalty_settings WHERE id=1`).
		Scan(&en, &ppk, &rate)
	return en, ppk, rate, err
}

// nextOrderNumber assigns a short, globally-unique MND-NNNNNN from a single
// sequence. nextval is atomic, so offline/multi-device sales never collide
// (plan §5); order_number is also UNIQUE as a backstop.
func nextOrderNumber(ctx context.Context, tx pgx.Tx, _ string) (string, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT nextval('order_no_seq')`).Scan(&seq); err != nil {
		return "", fmt.Errorf("order number: %w", err)
	}
	return fmt.Sprintf("MND-%06d", seq), nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullNum(n float64) any {
	if n == 0 {
		return nil
	}
	return n
}
