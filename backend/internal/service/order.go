package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/write"
)

var (
	ErrNoItems     = errors.New("order has no items")
	ErrNoOutlet    = errors.New("order requires an outlet")
	ErrOrderClosed = errors.New("order not refundable")
)

// wib is the fixed Indonesia business zone (UTC+7, no DST) used to evaluate
// date-dependent loyalty triggers against the order's sale moment.
var wib = time.FixedZone("WIB", 7*3600)

// OrderItem is one cart line submitted by the client.
type OrderItem struct {
	ProductID   string  `json:"productId"`
	ProductName string  `json:"productName"`
	VariantSize string  `json:"variantSize"`
	Price       float64 `json:"price"`
	Quantity    int     `json:"quantity"`
	Subtotal    float64 `json:"subtotal"`
	IsBundle    bool    `json:"isBundle"`
	// SP-CRM-9: a free loyalty reward line. IsReward marks a Rp0 giveaway line;
	// RewardConditionID is the product_reward condition it fulfills (validated at
	// commit). Request-only — not persisted to order_items.
	IsReward          bool   `json:"isReward"`
	RewardConditionID string `json:"rewardConditionId"`
}

// CreateOrderInput is the resolved request. Outlet/cashier come from the JWT,
// never the payload. Offline=true (sync path) allows stock to go negative.
type CreateOrderInput struct {
	IdempotencyKey    string
	OrderUUID         string
	OrderNumber       string // client display number ({OUTLET}-{DEV}{SEQ}); server assigns if empty
	DeviceID          string // optional (sync clients)
	OutletID          string
	CashierID         string
	CashierName       string
	SalesmanID        string
	SalesmanName      string
	CustomerID        string
	CustomerName      string
	Items             []OrderItem
	PaymentMethod     string
	AmountPaid        float64
	ManualKind        DiscountKind
	ManualValue       float64
	Surcharge         float64
	SurchargeKind     DiscountKind
	DiscountCode      string // promo code applied
	PromotionID       string // applied promotion id
	DiscountLabel     string // denormalized source: promotion name / code / "Manual"
	DiscountBreakdown []byte // raw JSON array of {label,kind,value,amount}; stored as jsonb
	PointsRedeemed    int    // loyalty points the customer spends on this order
	Notes             string
	ShiftID           string
	ClientCreated     *time.Time
	Offline           bool
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
	// Read the cached balance once under row-lock for any loyalty customer — used
	// both for the redemption clamp and as balance_before for the ledger entries.
	hasLoyaltyCustomer := in.CustomerID != "" && loyEnabled
	balanceBefore := 0
	var evalCust EvalCustomer
	if hasLoyaltyCustomer {
		if e := tx.QueryRow(ctx,
			`SELECT points, birthday, anniversary, visit_count
			   FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&balanceBefore, &evalCust.Birthday, &evalCust.Anniversary, &evalCust.VisitCount); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
	}
	pointsRedeemed := 0
	redeemAmount := 0.0
	if in.PointsRedeemed > 0 && hasLoyaltyCustomer && redemptionRate > 0 {
		pointsRedeemed = in.PointsRedeemed
		if pointsRedeemed > balanceBefore {
			pointsRedeemed = balanceBefore
		}
		redeemAmount = float64(pointsRedeemed) * redemptionRate
		if redeemAmount > res.Total {
			redeemAmount = res.Total
			pointsRedeemed = int(res.Total / redemptionRate)
		}
	}
	finalTotal := res.Total - redeemAmount

	// Loyalty-condition engine (SP-CRM-8): base × bestMultiplier + Σ set_points.
	// Inert when no condition matches → finalEarned == base (byte-identical to before).
	base := res.EarnedPoints
	finalEarned := base
	// Default to the identity multiplier so a future reader can't get FinalEarned==0
	// from a zero-value outcome (EvaluateLoyalty also returns BestMultiplier>=1.0).
	outcome := LoyaltyOutcome{BestMultiplier: 1.0}
	if hasLoyaltyCustomer {
		conds, e := loadActiveConditions(ctx, tx)
		if e != nil {
			return "", false, false, e
		}
		pidSet := make(map[string]bool, len(in.Items))
		for _, it := range in.Items {
			if it.IsReward {
				continue // a free reward item must not trigger more conditions
			}
			pidSet[it.ProductID] = true
		}
		saleTime := time.Now()
		if in.ClientCreated != nil {
			saleTime = *in.ClientCreated
		}
		outcome = EvaluateLoyalty(conds, EvalContext{
			Total: res.Total, BasePoints: base, ProductIDs: pidSet,
			SaleDate: saleTime.In(wib), Customer: evalCust,
		})
		finalEarned = outcome.FinalEarned(base)
	}

	// Per-outlet stock decrement under row lock (FOR UPDATE). Stock lives in
	// outlet_variant_stock keyed by (outlet_id, product_id, variant_size). A row
	// is created lazily at 0 the first time an outlet sells a real variant (an
	// un-stocked outlet starts empty; the backfilled primary outlet keeps its
	// number). Bundle components / deleted variants have no product_variants row
	// and are skipped, matching legacy behavior.
	for _, it := range in.Items {
		if _, e := tx.Exec(ctx, `
			INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			SELECT $1,$2,$3,0
			WHERE EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=$2 AND pv.size=$3)
			ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING`,
			in.OutletID, it.ProductID, it.VariantSize); e != nil {
			return "", false, false, fmt.Errorf("ensure stock row: %w", e)
		}
		var stock int
		e := tx.QueryRow(ctx,
			`SELECT stock FROM outlet_variant_stock
			   WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3 FOR UPDATE`,
			in.OutletID, it.ProductID, it.VariantSize).Scan(&stock)
		if errors.Is(e, pgx.ErrNoRows) {
			continue // bundle component or deleted variant — skip, do not fail the sale
		}
		if e != nil {
			return "", false, false, fmt.Errorf("lock variant stock: %w", e)
		}
		next := stock - it.Quantity
		if next < 0 {
			if in.Offline {
				stockWarning = true // recorded, flagged for admin reconciliation
			} else {
				next = 0 // online zero-floor (legacy parity)
			}
		}
		if _, e := tx.Exec(ctx,
			`UPDATE outlet_variant_stock SET stock=$1
			   WHERE outlet_id=$2 AND product_id=$3 AND variant_size=$4`,
			next, in.OutletID, it.ProductID, it.VariantSize); e != nil {
			return "", false, false, fmt.Errorf("decrement stock: %w", e)
		}
	}

	// Client-authoritative display number ({OUTLET}-{DEV}{SEQ}); fall back to the
	// legacy server sequence only when the client didn't supply one (older apps).
	orderNumber := in.OrderNumber
	if orderNumber == "" {
		orderNumber, err = nextOrderNumber(ctx, tx, in.OutletID)
		if err != nil {
			return "", false, false, err
		}
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
		  stock_warning, points_redeemed, discount_label, discount_breakdown, points_earned)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
		        $19,$20,$21,$22,$23,$24,'completed',$25,$26,$27,$28,$29,$30,$31,$32::jsonb,$33)
		RETURNING id`,
		orderNumber, in.OrderUUID, in.IdempotencyKey, nullUUID(in.DeviceID), in.OutletID,
		in.CashierID, in.CashierName, nullUUID(in.SalesmanID), nullStr(in.SalesmanName),
		nullUUID(in.CustomerID), nullStr(in.CustomerName),
		res.Subtotal, res.DiscountAmount, nullStr(string(in.ManualKind)),
		nullNum(in.ManualValue), nullStr(in.DiscountCode),
		nullStr(string(in.SurchargeKind)), nullNum(in.Surcharge), res.SurchargeAmount,
		res.TaxAmount, finalTotal, in.PaymentMethod, amountPaid, change,
		nullStr(in.Notes), nullUUID(in.ShiftID), in.ClientCreated, finalTotal,
		stockWarning, pointsRedeemed, nullStr(in.DiscountLabel), nullBytes(in.DiscountBreakdown),
		finalEarned,
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
			finalTotal, finalEarned, in.CustomerID, pointsRedeemed); e != nil {
			return "", false, false, fmt.Errorf("update customer: %w", e)
		}

		// Ledger (SP-CRM-7): only for loyalty customers (balanceBefore was read under
		// the same row lock). earned/pointsRedeemed are 0 when loyalty is off, but the
		// explicit guard stops a future edit from firing these with a stale balanceBefore==0.
		// Same tx → inherits the order's idempotency guard (a replayed order won't double-log).
		if hasLoyaltyCustomer {
			earned := finalEarned
			if earned > 0 {
				if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
					CustomerID: in.CustomerID, Type: "earn", Points: earned,
					BalanceAfter: balanceBefore + earned,
					Reason:       LoyaltyEarnReason(orderNumber, base, outcome),
					OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
				}); e != nil {
					return "", false, false, fmt.Errorf("ledger earn: %w", e)
				}
			}
			if pointsRedeemed > 0 {
				if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
					CustomerID: in.CustomerID, Type: "redeem", Points: -pointsRedeemed,
					BalanceAfter: balanceBefore + earned - pointsRedeemed,
					Reason:       fmt.Sprintf("Penukaran poin di transaksi %s", orderNumber),
					OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
				}); e != nil {
					return "", false, false, fmt.Errorf("ledger redeem: %w", e)
				}
			}
			// Audit. set_points / multiply_points record on match (unchanged).
			// product_reward records ONLY when a validated reward line fulfills it
			// (SP-CRM-9 "actually received"); collect the matched menus for that.
			rewardMenu := make(map[string]AppliedCondition) // conditionID -> matched product_reward
			for _, a := range outcome.Applied {
				if a.RewardType == "product_reward" {
					rewardMenu[a.ConditionID] = a
					continue
				}
				if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
					OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
					ConditionName: a.Name, Trigger: a.Trigger, RewardType: a.RewardType,
					RewardValue: a.RewardValue, PointsContributed: a.PointsContributed,
					RewardProductIDs: a.RewardProductIDs,
				}); e != nil {
					return "", false, false, fmt.Errorf("record condition application: %w", e)
				}
			}
			// One validated grant per reward line; ≤1 per condition (also enforced
			// by UNIQUE(order_id, condition_id)). Invalid lines are dropped + logged
			// (lenient — the staff POS already trusts client item prices).
			seenReward := make(map[string]bool)
			for _, it := range in.Items {
				if !it.IsReward {
					continue
				}
				a, ok := rewardMenu[it.RewardConditionID]
				if !ok || seenReward[it.RewardConditionID] || !contains(a.RewardProductIDs, it.ProductID) {
					slog.Warn("dropping unfulfillable reward line from audit",
						"order_id", orderID, "condition_id", it.RewardConditionID, "product_id", it.ProductID)
					continue
				}
				seenReward[it.RewardConditionID] = true
				if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
					OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
					ConditionName: a.Name, Trigger: a.Trigger, RewardType: "product_reward",
					RewardValue: a.RewardValue, PointsContributed: 0,
					RewardProductIDs: []string{it.ProductID}, // the CHOSEN product
				}); e != nil {
					return "", false, false, fmt.Errorf("record reward fulfillment: %w", e)
				}
			}
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

	var status, orderNumber string
	var custID *string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed)
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
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			   VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			outletID, r.pid, r.size, r.qty); err != nil {
			return err
		}
	}

	// Points reversal (SP-CRM-7): claw back earned (floor 0, forgive remainder) and
	// restore redeemed. Idempotent: the already-refunded short-circuit above means
	// this runs at most once per order.
	// SP-CRM-8: orders.points_earned now stores the FULL engine total (base × mult +
	// bonuses), so this clawback reverses bonuses too with no change here. Condition
	// application rows are immutable order-time facts and are intentionally not reversed.
	if custID != nil && *custID != "" {
		// Safe lock order: this tx already holds the orders row lock; acquiring the
		// customers row lock here can't cycle with CreateOrder (which locks customers
		// then inserts a NEW orders row — different rows, no shared cycle).
		var bal int
		if e := tx.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, *custID).Scan(&bal); e != nil {
			return fmt.Errorf("load points for refund: %w", e)
		}
		clawback := write.PointsClawback(bal, oEarned)
		afterClaw := bal - clawback
		if clawback > 0 {
			clawReason := fmt.Sprintf("Pembatalan poin dari refund %s", orderNumber)
			if oEarned > clawback {
				clawReason += fmt.Sprintf(" (%d poin dimaafkan)", oEarned-clawback)
			}
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *custID, Type: "refund", Points: -clawback,
				BalanceAfter: afterClaw, Reason: clawReason, OrderID: orderID,
			}); e != nil {
				return fmt.Errorf("ledger refund clawback: %w", e)
			}
		}
		newBal := afterClaw + oRedeemed
		if oRedeemed > 0 {
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *custID, Type: "refund", Points: oRedeemed,
				BalanceAfter: newBal,
				Reason:       fmt.Sprintf("Pengembalian poin tukar dari refund %s", orderNumber),
				OrderID:      orderID,
			}); e != nil {
				return fmt.Errorf("ledger refund restore: %w", e)
			}
		}
		if clawback > 0 || oRedeemed > 0 {
			if _, e := tx.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, *custID, newBal); e != nil {
				return fmt.Errorf("update points on refund: %w", e)
			}
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

// rowQueryRower is satisfied by both *pgxpool.Pool and pgx.Tx, so loadLoyalty
// can run on the pool (preview) or inside the order tx (commit).
type rowQueryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func loadLoyalty(ctx context.Context, q rowQueryRower) (bool, float64, float64, error) {
	var en bool
	var ppk, rate float64
	err := q.QueryRow(ctx,
		`SELECT enabled, points_per_thousand, redemption_rate
		   FROM loyalty_settings WHERE id=1`).
		Scan(&en, &ppk, &rate)
	return en, ppk, rate, err
}

// rowQuerier is satisfied by both *pgxpool.Pool and pgx.Tx, so loadActiveConditions
// can run inside the order tx (commit) or directly on the pool (preview).
type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// loadActiveConditions reads the active loyalty_conditions inside the order tx into
// the pure engine struct. Ordered (created_at, id) so multiply-tie attribution is
// deterministic. jsonb arrays scan directly into Go slices (pgx v5), as in resolvePromo.
func loadActiveConditions(ctx context.Context, q rowQuerier) ([]LoyaltyCondition, error) {
	rows, err := q.Query(ctx, `
		SELECT id, name, type, trigger, reward_type, reward_value,
		       COALESCE(reward_product_ids,'[]'::jsonb),
		       campaign_start_date, campaign_end_date,
		       COALESCE(active_days,'[]'::jsonb),
		       COALESCE(applicable_product_ids,'[]'::jsonb),
		       minimum_spend, is_active
		  FROM loyalty_conditions
		 WHERE is_active = true
		 ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("load loyalty conditions: %w", err)
	}
	defer rows.Close()
	var out []LoyaltyCondition
	for rows.Next() {
		var c LoyaltyCondition
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.Trigger, &c.RewardType, &c.RewardValue,
			&c.RewardProductIDs, &c.CampaignStartDate, &c.CampaignEndDate,
			&c.ActiveDays, &c.ApplicableProductIDs, &c.MinimumSpend, &c.IsActive); err != nil {
			return nil, fmt.Errorf("scan loyalty condition: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
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

// CreateCustomerInput is an offline-created customer flushed from the POS outbox.
// The client generates the UUID so a queued order can reference it before it
// reaches the server.
type CreateCustomerInput struct {
	ID    string
	Name  string
	Phone string
	Email string
}

// CreateCustomer inserts (or upserts) a customer using the client-provided UUID,
// so offline new-customer creation works and is replay-safe.
func (s *OrderService) CreateCustomer(ctx context.Context, in CreateCustomerInput) (string, error) {
	if in.Name == "" || in.Phone == "" {
		return "", errors.New("customer requires name and phone")
	}
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO customers (id, name, phone, email)
		VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), $2, $3, $4)
		ON CONFLICT (id) DO UPDATE
		  SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email
		RETURNING id`,
		in.ID, in.Name, in.Phone, nullStr(in.Email)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create customer: %w", err)
	}
	// SP-CRM-3: if another customer already has this phone, record a duplicate
	// candidate for the future backoffice merge tool. Best-effort — never blocks
	// the create (the in-flight order depends on it). The customer row is still
	// created with the client id, so the order's customerId stays consistent.
	var existingID string
	if derr := s.Pool.QueryRow(ctx,
		`SELECT id FROM customers WHERE phone = $1 AND id <> $2 ORDER BY created_at ASC, id ASC LIMIT 1`,
		in.Phone, id).Scan(&existingID); derr == nil && existingID != "" {
		if _, execErr := s.Pool.Exec(ctx,
			`INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, id, existingID, in.Phone); execErr != nil {
			slog.Warn("dup candidate insert failed (best-effort)",
				"new_id", id, "existing_id", existingID, "err", execErr)
		}
	}
	return id, nil
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

// nullBytes returns nil for empty raw JSON so a $N::jsonb param stores SQL NULL
// instead of failing to parse an empty string.
func nullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}
