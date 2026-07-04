package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
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
	RewardPromotionID string `json:"rewardPromotionId"` // SP-Promo-3b reward fulfillment: the buy_x_get_y promo that gave this line
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
	DiscountCode      string   // promo code applied
	PromotionID       string   // applied promotion id
	PromotionIDs      []string // SP-Promo-3a: stacked promotions; falls back to PromotionID
	DiscountCodes     []string // SP-Promo-3a: stacked codes; falls back to DiscountCode
	DiscountLabel     string   // denormalized source: promotion name / code / "Manual"
	DiscountBreakdown []byte   // raw JSON array of {label,kind,value,amount}; stored as jsonb
	PointsRedeemed    int      // loyalty points the customer spends on this order
	Notes             string
	ShiftID           string
	ClientCreated     *time.Time
	Offline           bool
}

type OrderService struct{ Pool *pgxpool.Pool }

func NewOrderService(p *pgxpool.Pool) *OrderService { return &OrderService{Pool: p} }

// resolveMergedCustomer follows customers.merged_into to the terminal (non-merged)
// keeper id, so an order placed against a stale/tombstoned dup id (e.g. from an
// offline POS cache that synced late) lands on the live keeper. Capped + cycle-safe.
func resolveMergedCustomer(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	cur := id
	for i := 0; i < 10; i++ {
		var mi *string
		err := tx.QueryRow(ctx, `SELECT merged_into FROM customers WHERE id=$1`, cur).Scan(&mi)
		if errors.Is(err, pgx.ErrNoRows) {
			return cur, nil // unknown id: leave as-is, downstream load handles it
		}
		if err != nil {
			return "", fmt.Errorf("resolve merged customer: %w", err)
		}
		if mi == nil || *mi == "" {
			return cur, nil // terminal: not merged
		}
		cur = *mi
	}
	return cur, nil // hop cap reached (defensive); use the furthest resolved id
}

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

	// SP-Promo-1: validate the applied discount against its stored rules. Subtotal
	// (pre-discount) is needed for min_purchase; saleTime (WIB) for date/hour/day
	// gating — hoisted here and reused by the loyalty engine below.
	var promoSubtotal float64
	for _, it := range in.Items {
		promoSubtotal += it.Subtotal
	}
	saleTime := time.Now()
	if in.ClientCreated != nil {
		saleTime = *in.ClientCreated
	}
	promoEvalCtx := PromoEvalContext{SaleTimeWIB: saleTime.In(wib), OutletID: in.OutletID, Subtotal: promoSubtotal}

	// SP-Promo-3a: prefer the plural lists; fall back to the singular fields so old
	// APKs (which send only promotionId/discountCode) keep working during rollout.
	promoIDs := in.PromotionIDs
	if len(promoIDs) == 0 && in.PromotionID != "" {
		promoIDs = []string{in.PromotionID}
	}
	codes := in.DiscountCodes
	if len(codes) == 0 && in.DiscountCode != "" {
		codes = []string{in.DiscountCode}
	}
	// C1: appliedCodes is now the RESOLVED code strings returned by resolvePromos —
	// only codes that successfully loaded are included, so refund mirrors create exactly.
	// M2: the old `if len(appliedCodes)==0 { appliedCodes = nil }` block is gone;
	// nullCodes already treats an empty/nil slice as SQL NULL.
	promos, promoCodeIDs, appliedCodes, discountWarnReason, err := s.resolvePromos(ctx, tx, promoIDs, codes, promoEvalCtx, in.Offline)
	if err != nil {
		return "", false, false, err
	}
	discountWarning := discountWarnReason != ""

	taxEnabled, taxRate, roundEnabled, roundType, err := loadAppSettings(ctx, tx)
	if err != nil {
		return "", false, false, err
	}
	loyEnabled, pointsPerK, redemptionRate, err := loadLoyalty(ctx, tx)
	if err != nil {
		return "", false, false, err
	}

	// SP-Promo-3b reward fulfillment: validate every buy_x_get_y reward line against
	// its promo's get-set + earned quota, reprice it to the SERVER net (never the
	// client value), drop offline-invalid lines, and 422 an online-invalid one. The
	// returned grants are written after the order row exists (orderID FK). This MUST
	// run before pricing/stock/order_items so all of them see the corrected lines.
	rewardGrants, rewardWarnReason, err := s.resolveRewardLines(ctx, tx, &in)
	if err != nil {
		return "", false, false, err
	}
	if rewardWarnReason != "" {
		// an offline order dropped an unfulfillable reward line — flag for admin
		// reconciliation, joining onto any existing discount warning reason.
		discountWarning = true
		if discountWarnReason == "" {
			discountWarnReason = rewardWarnReason
		} else {
			discountWarnReason += "," + rewardWarnReason
		}
	}

	items := make([]LineItem, len(in.Items))
	for i, it := range in.Items {
		items[i] = LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal}
	}
	res := Compute(PricingInput{
		Items: items, ManualDiscount: in.ManualValue, ManualKind: in.ManualKind,
		Surcharge: in.Surcharge, SurchargeKind: in.SurchargeKind, Promos: promos,
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
	// SP-CRM-Merge: resolve a stale/tombstoned duplicate customer id (e.g. from an
	// offline POS cache that synced late) to the terminal keeper id. All downstream
	// writes (order row, points, aggregates) then land on the live keeper.
	if in.CustomerID != "" {
		keeperID, e := resolveMergedCustomer(ctx, tx, in.CustomerID)
		if e != nil {
			return "", false, false, e
		}
		in.CustomerID = keeperID // all downstream order/points/aggregate writes target the keeper
	}

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
		pidSet := make(map[string]bool, len(in.Items)*2)
		for _, it := range in.Items {
			if it.IsReward {
				continue // a free reward item must not trigger more conditions
			}
			pidSet[it.ProductID] = true
			if it.VariantSize != "" {
				pidSet[variantKey(it.ProductID, it.VariantSize)] = true // variant-level trigger entries (SP-CRM-9b)
			}
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
		  stock_warning, points_redeemed, discount_label, discount_breakdown, points_earned, discount_warning, discount_warning_reason, applied_discount_codes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
		        $19,$20,$21,$22,$23,$24,'completed',$25,$26,$27,$28,$29,$30,$31,$32::jsonb,$33,$34,$35,$36::jsonb)
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
		finalEarned, discountWarning, nullStr(discountWarnReason), nullCodes(appliedCodes),
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

	// SP-Promo-3b: record one promo_reward_grants row per honored reward line (the
	// order row now exists for the FK). Each grant carries the SERVER full/net prices
	// resolved above — the audit of what was given for free.
	for _, g := range rewardGrants {
		g.OrderID = orderID
		if e := write.InsertRewardGrant(ctx, tx, g); e != nil {
			return "", false, false, fmt.Errorf("record reward grant: %w", e)
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
				if !ok || seenReward[it.RewardConditionID] || !rewardLineAllowed(a.RewardProductIDs, it.ProductID, it.VariantSize) {
					slog.Warn("dropping unfulfillable reward line from audit",
						"order_id", orderID, "condition_id", it.RewardConditionID, "product_id", it.ProductID, "variant_size", it.VariantSize)
					continue
				}
				seenReward[it.RewardConditionID] = true
				chosen := it.ProductID // grant records the CHOSEN item; "pid|size" when the size is known
				if it.VariantSize != "" {
					chosen = variantKey(it.ProductID, it.VariantSize)
				}
				if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
					OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
					ConditionName: a.Name, Trigger: a.Trigger, RewardType: "product_reward",
					RewardValue: a.RewardValue, PointsContributed: 0,
					RewardProductIDs: []string{chosen}, // the CHOSEN product
				}); e != nil {
					return "", false, false, fmt.Errorf("record reward fulfillment: %w", e)
				}
			}
		}
	}

	// Promo usage increment — one per applied code (each row was locked FOR UPDATE
	// in resolvePromos, so this is race-safe). SP-Promo-3a: a stack increments each.
	for _, codeID := range promoCodeIDs {
		if _, e := tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count=usage_count+1 WHERE id=$1`,
			codeID); e != nil {
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
	var discountCode *string
	var appliedCodes []string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed, &discountCode, &appliedCodes)
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
	// SP-Promo-3a: restore usage for EVERY applied code. Fall back to the singular
	// discount_code for pre-feature orders (applied_discount_codes is NULL there).
	// GREATEST(-1,0) + the already-refunded short-circuit keep this idempotent.
	restore := appliedCodes
	if len(restore) == 0 && discountCode != nil && *discountCode != "" {
		restore = []string{*discountCode}
	}
	for _, code := range restore {
		if code == "" {
			continue
		}
		if _, err = tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`,
			code); err != nil {
			return fmt.Errorf("restore discount usage: %w", err)
		}
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

// combinabilityViolation enforces the boolean gate: more than one discount may
// only coexist if EVERY one is combinable. A single discount never gates.
func combinabilityViolation(combinable []bool) *PromoViolation {
	if len(combinable) <= 1 {
		return nil
	}
	for _, c := range combinable {
		if !c {
			v := ViolationNotCombinable
			return &v
		}
	}
	return nil
}

// dedupeNonEmpty returns a new slice with empty strings removed and duplicate
// strings eliminated (first occurrence wins, order preserved). Returns nil when
// the input is nil or all elements are empty.
func dedupeNonEmpty(ss []string) []string {
	if len(ss) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(ss))
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// combinedViolations returns code-gate + linked-promotion violations as a fresh
// slice (Model A intersection: a linked code passes only if BOTH the code's gates
// and the promotion's rules pass). Does not mutate either argument.
func combinedViolations(code, promo []PromoViolation) []PromoViolation {
	out := make([]PromoViolation, 0, len(code)+len(promo))
	out = append(out, code...)
	out = append(out, promo...)
	return out
}

// parseTieredConfig unmarshals the tiered_config jsonb. nil/empty -> (nil, nil).
func parseTieredConfig(raw []byte) (*TieredConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c TieredConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse tiered_config: %w", err)
	}
	return &c, nil
}

// parseBXGYConfig unmarshals the bxgy_config jsonb. nil/empty -> (nil, nil).
func parseBXGYConfig(raw []byte) (*BXGYConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c BXGYConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse bxgy_config: %w", err)
	}
	return &c, nil
}

// parseBundleConfig unmarshals the bundle_config jsonb. nil/empty -> (nil, nil).
func parseBundleConfig(raw []byte) (*BundleConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c BundleConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse bundle_config: %w", err)
	}
	return &c, nil
}

// loadPromoSpec loads an ACTIVE promotion by id, builds its PromoSpec, and returns
// its combinable + code_only flags and validation violations. found=false on
// ErrNoRows (caller decides reject-vs-flag by origin).
func (s *OrderService) loadPromoSpec(ctx context.Context, tx pgx.Tx, promoID string, ec PromoEvalContext) (spec PromoSpec, combinable, codeOnly bool, vio []PromoViolation, found bool, err error) {
	var kind string
	var value float64
	var ids []string
	var row PromoRow
	var bxgyRaw []byte
	var tieredRaw []byte
	var bundleRaw []byte
	e := tx.QueryRow(ctx,
		`SELECT type, value,
		   COALESCE(applicable_product_ids,'[]'::jsonb),
		   start_date, end_date, min_purchase,
		   COALESCE(active_from_hour,''), COALESCE(active_to_hour,''),
		   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb),
		   COALESCE(combinable,false), COALESCE(code_only,false), bxgy_config, tiered_config,
		   bundle_config
		   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
		Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
			&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs,
			&row.Combinable, &codeOnly, &bxgyRaw, &tieredRaw, &bundleRaw)
	if errors.Is(e, pgx.ErrNoRows) {
		return PromoSpec{}, false, false, nil, false, nil
	}
	if e != nil {
		return PromoSpec{}, false, false, nil, false, fmt.Errorf("load promotion: %w", e)
	}
	spec = PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
	if spec.Kind == DiscountBuyXGetY {
		cfg, perr := parseBXGYConfig(bxgyRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.BXGY = cfg
	}
	if spec.Kind == DiscountTiered {
		cfg, perr := parseTieredConfig(tieredRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.Tiered = cfg
	}
	if spec.Kind == DiscountBundle {
		cfg, perr := parseBundleConfig(bundleRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.Bundle = cfg
	}
	return spec, row.Combinable, codeOnly, ValidatePromo(row, ec), true, nil
}

// resolvePromos turns the applied promotion ids + discount codes into authoritative
// PromoSpecs, validating each stored gating rule (SP-Promo-1) AND the cross-discount
// combinability gate (SP-Promo-3a). Returns the applied discount_codes row ids (for
// usage++), the RESOLVED code strings that parallel codeIDs (for persisting to
// applied_discount_codes — only codes that successfully loaded), a non-empty
// warnReason when an OFFLINE order applied invalid/conflicting discounts (recorded +
// flagged), and *ErrDiscountRejected for an ONLINE conflict (caller -> HTTP 422).
//
// SP-Promo-3c (Model A): when a discount code has a non-null promotion_id, the LINKED
// PROMOTION supplies all discount mechanics; the code acts as a key — both the code's
// gates (ValidateCode) AND the promotion's rules (ValidatePromo) must pass (intersection).
// A code_only promotion is blocked on the direct promoIDs path and only reachable via a
// linked code. Deduplication prevents the same promotion from being applied twice across
// the direct and linked paths.
func (s *OrderService) resolvePromos(ctx context.Context, tx pgx.Tx, promoIDs, codes []string, ec PromoEvalContext, offline bool) ([]PromoSpec, []string /*codeIDs*/, []string /*appliedCodes*/, string, error) {
	// I1: dedupe both lists before processing — a duplicate code would double-increment
	// usage_count and falsely trip the combinability gate (two entries → len>1).
	promoIDs = dedupeNonEmpty(promoIDs)
	codes = dedupeNonEmpty(codes)

	var specs []PromoSpec
	var codeIDs []string
	var appliedCodes []string
	var combinable []bool
	var violations []PromoViolation
	seen := map[string]bool{} // resolved promotion ids already applied (cross-path dedupe)

	reject := func(v []PromoViolation) ([]PromoSpec, []string, []string, string, error) {
		return nil, nil, nil, "", &ErrDiscountRejected{Violations: v}
	}

	// ── direct promotions ────────────────────────────────────
	for _, promoID := range promoIDs {
		if promoID == "" {
			continue
		}
		spec, comb, codeOnly, vio, found, err := s.loadPromoSpec(ctx, tx, promoID, ec)
		if err != nil {
			return nil, nil, nil, "", err
		}
		if !found {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		// code_only promotions can't be applied directly — only via a linked code.
		if codeOnly {
			if !offline {
				return reject([]PromoViolation{ViolationCodeOnly})
			}
			violations = append(violations, ViolationCodeOnly)
			continue
		}
		if len(vio) > 0 {
			if !offline {
				return reject(vio)
			}
			violations = append(violations, vio...)
		}
		seen[promoID] = true
		specs = append(specs, spec)
		combinable = append(combinable, comb)
	}

	// ── discount codes ───────────────────────────────────────
	for _, code := range codes {
		if code == "" {
			continue
		}
		var id, kind string
		var value float64
		var promotionID *string
		var row CodeRow
		// FOR UPDATE: hold the row lock from validation through usage_count++ later
		// in this same tx — makes the usage_limit check race-safe.
		err := tx.QueryRow(ctx,
			`SELECT id, promotion_id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &promotionID, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		if err != nil {
			return nil, nil, nil, "", fmt.Errorf("load discount code: %w", err)
		}

		codeVio := ValidateCode(row, ec)

		// ── LINKED CODE (Model A: code is a key) ──────────────
		if promotionID != nil && *promotionID != "" {
			if seen[*promotionID] {
				slog.Warn("linked promotion already applied; skipping redundant code",
					"code", code, "promotionId", *promotionID)
				continue
			}
			pspec, pcomb, _, pvio, found, lerr := s.loadPromoSpec(ctx, tx, *promotionID, ec)
			if lerr != nil {
				return nil, nil, nil, "", lerr
			}
			if !found {
				if !offline {
					return reject([]PromoViolation{ViolationNotFound})
				}
				violations = append(violations, ViolationNotFound)
				continue
			}
			if all := combinedViolations(codeVio, pvio); len(all) > 0 {
				if !offline {
					return reject(all)
				}
				violations = append(violations, all...)
			}
			seen[*promotionID] = true
			specs = append(specs, pspec)
			combinable = append(combinable, pcomb)
			codeIDs = append(codeIDs, id)
			appliedCodes = append(appliedCodes, code)
			continue
		}

		// ── UNLINKED CODE (pre-3c behavior, byte-identical) ───
		if len(codeVio) > 0 {
			if !offline {
				return reject(codeVio)
			}
			violations = append(violations, codeVio...)
		}
		spec := PromoSpec{Kind: DiscountKind(kind), Value: value}
		specs = append(specs, spec)
		// C1: append id and code string in lockstep so appliedCodes mirrors codeIDs.
		// Only codes that successfully loaded (no pgx.ErrNoRows continue above) reach here.
		codeIDs = append(codeIDs, id)
		appliedCodes = append(appliedCodes, code)
		combinable = append(combinable, row.Combinable)
	}

	if v := combinabilityViolation(combinable); v != nil {
		if !offline {
			return reject([]PromoViolation{*v})
		}
		violations = append(violations, *v)
	}

	warn := ""
	if len(violations) > 0 {
		warn = JoinViolations(violations)
	}
	return specs, codeIDs, appliedCodes, warn, nil
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

// rewardLineAllowed reports whether a reward line's chosen item is on the
// condition's menu: listed as the whole product ("pid") or the exact variant
// ("pid|size"). SP-CRM-9b composite entries.
func rewardLineAllowed(menu []string, productID, size string) bool {
	if contains(menu, productID) {
		return true
	}
	return size != "" && contains(menu, variantKey(productID, size))
}

// rewardCatalog is one reward product's catalog identity: server name + per-unit
// full (normal) price, looked up by (productId, variantSize). found=false means the
// variant is gone/inactive → the reward line is unfulfillable.
type rewardCatalog struct {
	name      string
	fullPrice float64
	found     bool
}

// loadRewardCatalog fetches the active product's name + variant price. A reward
// line whose variant no longer exists (deleted/inactive) is treated as invalid.
func loadRewardCatalog(ctx context.Context, tx pgx.Tx, productID, size string) (rewardCatalog, error) {
	var c rewardCatalog
	e := tx.QueryRow(ctx, `
		SELECT p.name, v.price
		  FROM products p
		  JOIN product_variants v ON v.product_id = p.id
		 WHERE p.id = $1 AND v.size = $2 AND p.is_active = true`,
		productID, size).Scan(&c.name, &c.fullPrice)
	if errors.Is(e, pgx.ErrNoRows) {
		return rewardCatalog{}, nil // unfulfillable, not a hard error
	}
	if e != nil {
		return rewardCatalog{}, fmt.Errorf("load reward catalog: %w", e)
	}
	c.found = true
	return c, nil
}

// resolveRewardLines validates each SP-Promo-3b buy_x_get_y reward line in in.Items
// against its promotion's get-set + earned quota, repricing valid lines to the
// SERVER net (never the client value) and emitting one grant row each. It mutates
// in.Items in place: valid reward lines get Price/Subtotal overwritten with the net;
// offline-invalid lines are removed entirely (not charged, not stocked, not granted).
// An ONLINE invalid line returns *ErrDiscountRejected{ViolationRewardInvalid} (→422).
// Returns grants (OrderID left blank for the caller to stamp) and a warn reason
// (non-empty only when an offline order dropped a line).
func (s *OrderService) resolveRewardLines(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) ([]write.RewardGrantRow, string, error) {
	// Fast exit: no reward lines reference a promo → nothing to do (common case).
	any := false
	for _, it := range in.Items {
		if it.IsReward && it.RewardPromotionID != "" {
			any = true
			break
		}
	}
	if !any {
		return nil, "", nil
	}

	// Paid (non-reward) lines drive the earned-quota math (hard contract: reward
	// lines must NOT count as buy units).
	var paid []LineItem
	for _, it := range in.Items {
		if it.IsReward {
			continue
		}
		paid = append(paid, LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal})
	}

	cfgCache := map[string]*BXGYConfig{} // promoID -> bxgyConfig (nil = absent/invalid promo)
	cfgLoaded := map[string]bool{}
	honored := map[string]int{} // promoID -> reward UNITS already honored this order

	bxgyFor := func(promoID string) (*BXGYConfig, error) {
		if cfgLoaded[promoID] {
			return cfgCache[promoID], nil
		}
		spec, _, _, _, found, err := s.loadPromoSpec(ctx, tx, promoID, PromoEvalContext{})
		if err != nil {
			return nil, err
		}
		var cfg *BXGYConfig
		if found && spec.Kind == DiscountBuyXGetY {
			cfg = spec.BXGY
		}
		cfgLoaded[promoID] = true
		cfgCache[promoID] = cfg
		return cfg, nil
	}

	var grants []write.RewardGrantRow
	kept := in.Items[:0] // reuse backing array; drops compact in place (offline only)
	var warns []PromoViolation

	for _, it := range in.Items {
		if !it.IsReward || it.RewardPromotionID == "" {
			kept = append(kept, it)
			continue
		}
		cfg, err := bxgyFor(it.RewardPromotionID)
		if err != nil {
			return nil, "", err
		}
		cat, err := loadRewardCatalog(ctx, tx, it.ProductID, it.VariantSize)
		if err != nil {
			return nil, "", err
		}

		ok, net := false, 0.0
		if cat.found {
			ok, net = rewardLineEntitled(cfg, paid, honored[it.RewardPromotionID], it.ProductID, it.VariantSize, cat.fullPrice)
		}
		// Quantity-aware quota: a qty-N reward line needs N units of remaining quota.
		if ok && cfg != nil && honored[it.RewardPromotionID]+it.Quantity > bxgyRewardDue(cfg, paid) {
			ok = false
		}
		if !ok {
			if !in.Offline {
				return nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationRewardInvalid}}
			}
			// Offline: drop the line (not charged/stocked/granted) and flag the order.
			slog.Warn("dropping unfulfillable reward line (offline)",
				"promotion_id", it.RewardPromotionID, "product_id", it.ProductID,
				"variant_size", it.VariantSize, "quantity", it.Quantity)
			warns = append(warns, ViolationRewardInvalid)
			continue
		}

		honored[it.RewardPromotionID] += it.Quantity
		// Server-authoritative repricing: never trust the client reward price.
		it.Price = net
		it.Subtotal = math.Round(net * float64(it.Quantity))
		kept = append(kept, it)
		// Write one grant row per unit (qty-N reward line → N rows) so the audit
		// table is one-row-per-unit and downstream reporting can count simply.
		for range it.Quantity {
			grants = append(grants, write.RewardGrantRow{
				PromotionID: it.RewardPromotionID, ProductID: it.ProductID,
				ProductName: cat.name, VariantSize: it.VariantSize,
				FullPrice: cat.fullPrice, RewardPrice: net, RewardValue: cat.fullPrice - net,
			})
		}
	}
	in.Items = kept

	warn := ""
	if len(warns) > 0 {
		warn = JoinViolations(warns)
	}
	return grants, warn, nil
}

// rewardLineEntitled reports whether a reward line (product/size at fullPrice) is
// allowed for this buy_x_get_y promo given the PAID lines and how many reward
// units of this promo were already honored, and returns the net price to charge.
func rewardLineEntitled(c *BXGYConfig, paid []LineItem, alreadyHonored int, productID, size string, fullPrice float64) (bool, float64) {
	if c == nil || len(c.GetProductIDs) == 0 {
		return false, 0
	}
	if !keyMatchesLine(c.GetProductIDs, productID, size) {
		return false, 0
	}
	if alreadyHonored >= bxgyRewardDue(c, paid) {
		return false, 0
	}
	return true, bxgyRewardNet(c, fullPrice)
}

// variantKey is the composite "pid|size" key shared by the loyalty trigger set,
// the reward-fulfillment grant, and rewardLineAllowed — they must agree, so the
// format lives in one place. SP-CRM-9b.
func variantKey(productID, size string) string {
	return productID + "|" + size
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

// nullCodes marshals applied code strings to a jsonb array, or NULL when empty.
func nullCodes(codes []string) any {
	if len(codes) == 0 {
		return nil
	}
	b, err := json.Marshal(codes)
	if err != nil {
		// M1: surface the error so it is not silently swallowed (per repo policy).
		// json.Marshal of []string cannot fail in practice, but log it if it ever does.
		slog.Error("marshal applied codes", "err", err)
		return nil
	}
	return b
}
