package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/bizday"
	"github.com/mandalika/pos-backend/internal/write"
)

var (
	ErrNoItems     = apperr.New(apperr.Rejected, "order has no items")
	ErrNoOutlet    = apperr.New(apperr.Rejected, "order requires an outlet")
	ErrOrderClosed = apperr.New(apperr.Conflict, "order not refundable")
)

// wib is the fixed WIB zone (UTC+7, no DST): the default outlet zone and the stamp zone
// promoDateOnly uses. Evaluation zones come from the outlet (outletZone).
var wib = bizday.Zone(bizday.Default)

// outletZone loads the outlet's timezone (A28) as a fixed-offset location. A missing outlet,
// NULL or unknown name is Asia/Jakarta, so outlets that never set a zone behave exactly as
// before. Compared as lower-cased text (envelope ids are case-insensitive) so a malformed id cannot abort the surrounding transaction.
func outletZone(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, outletID string) (*time.Location, error) {
	var tz *string
	err := q.QueryRow(ctx, `SELECT timezone FROM outlets WHERE id::text=lower($1)`, outletID).Scan(&tz)
	if errors.Is(err, pgx.ErrNoRows) {
		return wib, nil
	}
	if err != nil {
		return nil, fmt.Errorf("outlet timezone: %w", err)
	}
	if tz == nil {
		return wib, nil
	}
	return bizday.Zone(*tz), nil
}

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

	// Bundles (migration 0090): a bundle is three lines (large, atomizer, vial), qty 1 each,
	// sharing one per-order BundleGroup (1..32767). BundlePrice is the list price before any
	// Diskon Bundle, the same on all three pieces; BundleBasisPrice is this piece's single
	// price when it entered the cart. Not the legacy IsBundle flag.
	BundleGroup      int     `json:"bundleGroup"`
	BundleRole       string  `json:"bundleRole"`
	BundlePrice      float64 `json:"bundlePrice"`
	BundleBasisPrice float64 `json:"bundleBasisPrice"`

	// C4a, server-internal (never decoded from JSON): payloadLine is the 0-based index of
	// this line in the sale payload (stamped at the top of createOrderCore, survives the
	// reward-line compaction); group marks a validated bundle/BXGY reward line.
	payloadLine int
	group       *refundGroupInfo
	bundle      *setBundleInfo // filled by resolveSetBundles
}

// setBundleInfo is what the server resolved for a bundle piece (persisted to order_items).
type setBundleInfo struct {
	line, size  string
	discount    float64
	promotionID string
}

// CreateOrderInput is the resolved request. Outlet/cashier come from the JWT,
// never the payload. Offline=true (sync path) relaxes tender/promo enforcement; stock goes negative on both paths (A44) and every shortfall is recorded.
type CreateOrderInput struct {
	IdempotencyKey string
	OrderUUID      string
	OrderNumber    string // client display number ({OUTLET}-{DEV}{SEQ}); server assigns if empty
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
	// Tenders (C6) is the raw split-payment list: nil = absent (legacy scalar path); null,
	// [] and non-arrays are structural rejects (parseTenders). Ignores PaymentMethod/AmountPaid.
	Tenders           json.RawMessage
	ManualKind        DiscountKind
	ManualValue       float64
	Surcharge         float64
	SurchargeKind     DiscountKind
	DiscountCode      string          // promo code applied
	PromotionID       string          // applied promotion id
	PromotionIDs      []string        // SP-Promo-3a: stacked promotions; falls back to PromotionID
	DiscountCodes     []string        // SP-Promo-3a: stacked codes; falls back to DiscountCode
	DiscountLabel     string          // denormalized source: promotion name / code / "Manual"
	DiscountBreakdown []byte          // raw JSON array of {label,kind,value,amount}; stored as jsonb
	QuotedTotal       *float64        // A10: the total the POS showed/printed; nil = no quote (old clients)
	ReceiptSnapshot   json.RawMessage // A10: the printed receipt as sent; stored unchanged, never trusted for money
	PointsRedeemed    int             // loyalty points the customer spends on this order
	Notes             string
	ShiftID           string
	ClientCreated     *time.Time
	// Void replacement (migration 0093). ReplacesOrderID links the new sale to the one it replaces.
	// BusinessDate ("YYYY-MM-DD", empty = the 0059 trigger decides) pins the replacement to the voided
	// sale's day. CorrectionTarget (nil = none) is the total the sale must end at: the gap to what the
	// cart priced to is stored as orders.correction_amount ("Penyesuaian koreksi").
	ReplacesOrderID  string
	BusinessDate     string
	CorrectionTarget *int64
	// EvalTime and ClockSkew are set by the sync batch only (A05): the bounded time promo
	// and loyalty rules run at when ClientCreated disagrees with the server's evidence.
	// ClientCreated stays the recorded fact; EvalTime only changes the evaluation.
	EvalTime  *time.Time
	ClockSkew bool
	Offline   bool
}

// pickSaleTime is the time promo and loyalty rules evaluate at: the bounded EvalTime,
// else the client's capture time, else now.
func pickSaleTime(evalTime, clientCreated *time.Time) time.Time {
	switch {
	case evalTime != nil:
		return *evalTime
	case clientCreated != nil:
		return *clientCreated
	}
	return time.Now()
}

// withClockSkewWarning appends clock_skew to the discount warning reason when the sale's
// clock was bounded and a promo or code was applied. It never removes a discount.
func withClockSkewWarning(reason string, skew, promoApplied bool) string {
	if !skew || !promoApplied {
		return reason
	}
	if reason == "" {
		return string(ViolationClockSkew)
	}
	return reason + "," + string(ViolationClockSkew)
}

// pendingStockException is a sale line found short of stock (or unresolved) while
// the stock rows are locked; it is written once the order and item rows exist (A44).
type pendingStockException struct {
	line                    int
	kind                    string
	shortfall               int
	stockBefore, stockAfter *int
}

// shortfallOf is how many units of a sale line the balance could not cover:
// covered = clamp(stock, 0, qty); shortfall = qty - covered.
func shortfallOf(stock, qty int) int {
	covered := stock
	if covered < 0 {
		covered = 0
	}
	if covered > qty {
		covered = qty
	}
	return qty - covered
}

type OrderService struct{ Pool *pgxpool.Pool }

func NewOrderService(p *pgxpool.Pool) *OrderService { return &OrderService{Pool: p} }

// Row-lock order for the sale and refund commands (A42):
//
//	discount codes by code -> customer -> stock rows by (product_id, variant_size)
//	  -> new order row (create) / existing order row (refund, which reads the
//	     order, codes and customer UNLOCKED first so it can enter the same order)
//	  -> (void: codes -> customer -> order -> shift FOR SHARE -> stock rows, service/void.go)
//	  -> [content_versions rows] -> outlet_stock_seq row(s) in outlet_id order, LAST
//
// The last two steps (A15 Phase B) are shared by every stock writer, not only the
// sale and refund: whoever bumps content_versions does so BEFORE outlet_stock_seq,
// and write.BumpStockSeq is the last stock/version statement before Commit. Sale
// and refund take no content_versions row at all. A writer that bumped the seq in
// the middle (a trigger would) and took more stock rows afterwards would close a
// lock cycle with transfer send/receive/cancel and stock-count apply, which lock
// stock rows one per line; stockseq_guard_test.go enforces "bump is last".
//
// Merge locks both customers by id and then re-points orders (customer -> order
// rows, the refund order too). Transfers lock the transfer row, then stock rows
// (A13), and goods receipt (write/warehouse.go, outlet and warehouse) upserts stock rows
// in one statement ordered by (product_id, variant_size); neither takes codes or
// customers. Not covered: variant rename/delete in write/catalog.go
// touch stock rows unsorted (admin catalog edits, not on the sale path). Sorted
// locks use "ORDER BY ... FOR UPDATE" in SQL (PostgreSQL sorts before it locks) so
// the order is the database's, never a Go sort.

// CreateOrder runs the whole checkout in ONE transaction and is idempotent on
// IdempotencyKey: a replay (offline retry, two devices/outlets posting the same
// data) returns the canonical stored order and never double-inserts (plan §5).
// Returns the order id, whether it was a duplicate, and a stock warning flag.
func (s *OrderService) CreateOrder(ctx context.Context, in CreateOrderInput) (orderID string, dup bool, stockWarning bool, err error) {
	return s.createOrder(ctx, in, s.Pool.Begin)
}

// CreateOrderResult is CreateOrder's outcome plus the outlet stock counter value this
// sale produced (A15 Phase B). StockSeq is nil for a duplicate (a replay moves nothing,
// so it carries no counter value) and for the unit-test seams that bypass the bump.
type CreateOrderResult struct {
	OrderID      string
	Duplicate    bool
	StockWarning bool
	StockSeq     *int64
}

// CreateOrderSeq is CreateOrder that also returns the sale's outlet stock counter value,
// for the sync batch ack. The direct handler keeps using CreateOrder.
func (s *OrderService) CreateOrderSeq(ctx context.Context, in CreateOrderInput) (CreateOrderResult, error) {
	var seq int64
	id, dup, warn, err := s.createOrderCore(ctx, in, s.Pool.Begin, &seq)
	if err != nil {
		return CreateOrderResult{}, err
	}
	res := CreateOrderResult{OrderID: id, Duplicate: dup, StockWarning: warn}
	if !dup && seq > 0 {
		res.StockSeq = &seq
	}
	return res, nil
}

// The transaction seam keeps command-boundary regression tests isolated.
func (s *OrderService) createOrder(ctx context.Context, in CreateOrderInput, begin func(context.Context) (pgx.Tx, error)) (orderID string, dup bool, stockWarning bool, err error) {
	return s.createOrderCore(ctx, in, begin, nil)
}

// createOrderCore is the checkout body. seqOut (nil allowed) receives the outlet stock
// counter value after the bump; an out-parameter keeps the many return sites below as
// they were. It stays 0 on every non-committing path (replay, rollback).
func (s *OrderService) createOrderCore(ctx context.Context, in CreateOrderInput, begin func(context.Context) (pgx.Tx, error), seqOut *int64) (orderID string, dup bool, stockWarning bool, err error) {
	if len(in.Items) == 0 {
		return "", false, false, ErrNoItems
	}
	if in.OutletID == "" {
		return "", false, false, ErrNoOutlet
	}

	tx, err := begin(ctx)
	if err != nil {
		return "", false, false, err
	}
	defer tx.Rollback(ctx)

	res, err := s.createOrderTx(ctx, tx, in)
	if err != nil {
		if errors.Is(err, errOrderKeyConflict) {
			return s.replayAfterConflict(ctx, tx, in.IdempotencyKey, err)
		}
		return "", false, false, err
	}
	if res.Duplicate {
		return res.OrderID, true, false, nil
	}
	// A15 Phase B: tell every tablet at this outlet that its stock changed. Exactly once
	// per committed sale (a sale that moved no stock still counts, so one own sale is
	// always one bump), as the LAST statement: after the processed_keys claim, so a
	// lost same-key race rolls back with no gap, and after all stock rows.
	outletKey := strings.ToLower(strings.TrimSpace(in.OutletID)) // BumpStockSeq's map key
	seqs, e := write.BumpStockSeq(ctx, tx, in.OutletID)
	if e != nil {
		return "", false, false, e
	}
	if e := tx.Commit(ctx); e != nil {
		return "", false, false, fmt.Errorf("commit: %w", e)
	}
	if seqOut != nil {
		*seqOut = seqs[outletKey]
	}
	return res.OrderID, false, res.StockWarning, nil
}

// errOrderKeyConflict marks a lost same-key race inside createOrderTx. It cannot roll back the
// caller's transaction, so it reports the conflict: createOrderCore then replays the winner's key,
// a void's transaction returns it (retryable) and its outer receipt replays on the retry.
var errOrderKeyConflict = apperr.Wrap(apperr.Busy, write.ErrBusy)

// orderKeyConflict logs the database cause and returns the bare sentinel: the sentinel's text is
// what a sync ack or HTTP body may echo, and it must not carry constraint names or SQLSTATE.
func orderKeyConflict(cause error) error {
	slog.Warn("order idempotency key conflict", "err", cause)
	return errOrderKeyConflict
}

// createOrderTx is the checkout body inside a caller-owned transaction, from the processed_keys
// check to the processed_keys insert. It neither bumps the outlet stock counter nor commits: the
// caller does both (createOrderCore for a plain sale, VoidAndReplaceTx for a void with a replacement).
func (s *OrderService) createOrderTx(ctx context.Context, tx pgx.Tx, in CreateOrderInput) (CreateOrderResult, error) {
	id, dup, warn, err := s.createOrderBody(ctx, tx, in)
	if err != nil {
		return CreateOrderResult{}, err
	}
	return CreateOrderResult{OrderID: id, Duplicate: dup, StockWarning: warn}, nil
}

func (s *OrderService) createOrderBody(ctx context.Context, tx pgx.Tx, in CreateOrderInput) (orderID string, dup bool, stockWarning bool, err error) {
	if len(in.Items) == 0 {
		return "", false, false, ErrNoItems
	}
	if in.OutletID == "" {
		return "", false, false, ErrNoOutlet
	}

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
	// Known receipts retain the existing replay path above. Validate every NEW
	// command before any business write, irrespective of transport/offline flags.
	if err := ValidateSaleInput(in); err != nil {
		return "", false, false, err
	}
	// A12: a direct (online) sale may only name a shift of its own outlet. Checked for
	// NEW commands only, after the replay guard above, so a replay of a known key still
	// returns the canonical order. The batch path binds its shift in sync/attribute.go.
	if !in.Offline {
		if err := validateShiftOutlet(ctx, tx, in.OutletID, in.ShiftID); err != nil {
			return "", false, false, err
		}
	}
	// Reward resolution compacts/reprices in place; retain the caller's capture.
	in.Items = append([]OrderItem(nil), in.Items...)
	for i := range in.Items {
		in.Items[i].payloadLine = i // C4a: order_items.line_no = index in the sale payload
	}

	// SP-Promo-1: validate the applied discount against its stored rules. Subtotal
	// (pre-discount) is needed for min_purchase; saleTime (outlet-local) for date/hour/day
	// gating — hoisted here and reused by the loyalty engine below.
	var promoSubtotal float64
	for _, it := range in.Items {
		promoSubtotal += it.Subtotal
	}
	saleTime := pickSaleTime(in.EvalTime, in.ClientCreated)
	// A28 Phase B: promo hours/days/dates and loyalty date triggers run on the ORDER OUTLET's
	// clock. Unknown or missing outlet = Asia/Jakarta (the former fixed WIB).
	saleZone, err := outletZone(ctx, tx, in.OutletID)
	if err != nil {
		return "", false, false, err
	}
	promoEvalCtx := PromoEvalContext{SaleTimeLocal: saleTime.In(saleZone), OutletID: in.OutletID, Subtotal: promoSubtotal, HasCustomer: in.CustomerID != "", CustomerID: in.CustomerID}

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
	discountWarnReason = withClockSkewWarning(discountWarnReason, in.ClockSkew, len(promos) > 0 || len(appliedCodes) > 0)
	discountWarning := discountWarnReason != ""

	settings, err := loadAppSettings(ctx, tx)
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

	// SP-Promo-3b-bundle: validate/reprice bundle-freed lines (server-authoritative),
	// conserve stock, emit grants. Runs after resolveRewardLines (partitioned by promo
	// type) and before pricing/stock/order_items so all of them see the corrected lines.
	bundleGrants, bundleWarnReason, err := s.resolveBundleLines(ctx, tx, &in)
	if err != nil {
		return "", false, false, err
	}
	if bundleWarnReason != "" {
		discountWarning = true
		if discountWarnReason == "" {
			discountWarnReason = bundleWarnReason
		} else {
			discountWarnReason += "," + bundleWarnReason
		}
	}
	// Bundles (migration 0090): validate each three-piece bundle, reprice its pieces to their
	// share of the bundle price. Before pricing/stock/order_items so all of them see the shares.
	setBundleWarn, err := s.resolveSetBundles(ctx, tx, &in, promos)
	if err != nil {
		return "", false, false, err
	}
	if setBundleWarn != "" {
		discountWarning = true
		if discountWarnReason == "" {
			discountWarnReason = setBundleWarn
		} else {
			discountWarnReason += "," + setBundleWarn
		}
	}
	rewardGrants = append(rewardGrants, bundleGrants...)
	if err := validateSaleItems(in.Items, false); err != nil {
		return "", false, false, err
	}
	for _, grant := range rewardGrants {
		for _, value := range []float64{grant.FullPrice, grant.RewardPrice, grant.RewardValue} {
			if err := saleMoney("rewardGrant", value); err != nil {
				return "", false, false, err
			}
		}
	}

	items := make([]LineItem, len(in.Items))
	for i, it := range in.Items {
		items[i] = LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal, InBundle: it.BundleGroup > 0}
	}
	pricingIn := PricingInput{
		Items: items, ManualDiscount: in.ManualValue, ManualKind: in.ManualKind,
		Surcharge: in.Surcharge, SurchargeKind: in.SurchargeKind, Promos: promos,
		TaxEnabled: settings.TaxEnabled, TaxRate: settings.TaxRate,
		RoundingEnabled: settings.RoundingEnabled, RoundingType: settings.RoundingType,
		LoyaltyEnabled: loyEnabled, PointsPerK: pointsPerK,
		HasCustomer: in.CustomerID != "",
	}
	res := Compute(pricingIn)
	if err := validateSalePricing(res); err != nil {
		return "", false, false, err
	}
	if loyEnabled && in.CustomerID != "" {
		if err := salePoints("basePoints", math.Floor(res.Total/1000)*pointsPerK); err != nil {
			return "", false, false, err
		}
	}

	// Loyalty redemption (P1-E): authoritative rupiah value from
	// loyalty_settings.redemption_rate, clamped to the customer's available
	// points and to the order total (can't pay a negative bill).
	// Read the cached balance once under row-lock for any loyalty customer — used
	// both for the redemption clamp and as balance_before for the ledger entries.
	// SP-CRM-Merge: resolve a stale/tombstoned duplicate customer id (e.g. from an
	// offline POS cache that synced late) to the terminal keeper id. All downstream
	// writes (order row, points, aggregates) then land on the live keeper.
	if in.CustomerID != "" {
		// Resolve, lock (on EVERY customer sale, ahead of stock: the later UPDATE
		// customers and the order insert's FK key-share would otherwise lock the
		// customer after stock, the reverse of refund), then re-resolve under the lock.
		keeperID, e := lockResolvedCustomer(ctx, tx, in.CustomerID)
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
			// A missing customer is NOT a refusal: the POS creates customers on-device
			// and syncs customer_create first, so a failed/late create makes this
			// transient. Leave it unclassified (retryable internal).
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
		// This intermediate is capped to total below; preserve the existing cap.
		if math.IsNaN(redeemAmount) || math.IsInf(redeemAmount, 0) || redeemAmount < 0 {
			return "", false, false, saleInputError("redemptionAmount", "tidak valid")
		}
		if redeemAmount > res.Total {
			redeemAmount = res.Total
			pointsRedeemed = int(res.Total / redemptionRate)
		}
	}
	finalTotal := res.Total - redeemAmount
	// Void replacement: the sale ends at the target and the gap is "Penyesuaian koreksi". Points
	// earned are decided below from res.Total, before this adjustment, so the gap never moves them.
	var correction int64
	if in.CorrectionTarget != nil {
		correction = correctionAmount(*in.CorrectionTarget, int64(math.Round(finalTotal)))
		finalTotal = float64(*in.CorrectionTarget)
	}
	if err := saleMoney("finalTotal", finalTotal); err != nil {
		return "", false, false, err
	}

	// A09 tender rules, judged once per new sale (replays returned above). Online
	// (direct POST /orders) rejects only a cash shortfall; offline/batch sales and
	// non-cash mismatches are accepted with the captured amount and flagged.
	settle, err := settleSale(in, finalTotal, func(id string) bool { return IsCashMethod(settings.PaymentMethods, id) })
	if err != nil {
		return "", false, false, err
	}
	amountPaid, change, tenderReason := settle.AmountPaid, settle.Change, settle.Reason
	tenderWarning := tenderReason != ""

	// A10: judge the quoted receipt total after the replay guard, flag-only on both
	// routes. An unusable quote is dropped (NULL) with quote_invalid; the sale stands.
	quotedStored, quoteReason := evaluateQuote(in.QuotedTotal, in.ReceiptSnapshot, finalTotal)
	var snapStored json.RawMessage
	if quotedStored != nil {
		snapStored = in.ReceiptSnapshot
	}

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
		pidSet := loyaltyProductSet(in.Items) // skips reward lines and bundle pieces
		outcome = EvaluateLoyalty(conds, EvalContext{
			Total: res.Total, BasePoints: base, ProductIDs: pidSet,
			SaleDate: saleTime.In(saleZone), Customer: evalCust,
		})
		finalEarned = outcome.FinalEarned(base)
	}
	if err := salePoints("finalEarned", math.Round(float64(base)*outcome.BestMultiplier)+float64(outcome.FlatBonus)); err != nil {
		return "", false, false, err
	}
	if hasLoyaltyCustomer {
		if err := salePoints("balanceAfterEarn", float64(balanceBefore)+float64(finalEarned)); err != nil {
			return "", false, false, err
		}
		if err := salePoints("balanceAfterRedemption", float64(balanceBefore)+float64(finalEarned)-float64(pointsRedeemed)); err != nil {
			return "", false, false, err
		}
	}

	// Per-outlet stock decrement under row lock (FOR UPDATE). Stock lives in
	// outlet_variant_stock keyed by (outlet_id, product_id, variant_size). A row
	// is created lazily at 0 the first time an outlet sells a real variant (an
	// un-stocked outlet starts empty; the backfilled primary outlet keeps its
	// number). Bundle components / deleted variants have no product_variants row
	// and are skipped, matching legacy behavior.
	if e := lockStockRowsSorted(ctx, tx, in.OutletID, in.Items); e != nil {
		return "", false, false, e
	}
	var stockExceptions []pendingStockException
	for li, it := range in.Items {
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
			// Bundle component or deleted/renamed variant: the sale still succeeds and no
			// stock moves. A44: a non-bundle line is recorded so it is not silently lost,
			// and RefundTx must not restock it (the sale decremented nothing).
			if !it.IsBundle {
				stockWarning = true
				stockExceptions = append(stockExceptions, pendingStockException{
					line: li, kind: write.StockExceptionUnresolvedVariant, shortfall: it.Quantity,
				})
			}
			continue
		}
		if e != nil {
			return "", false, false, fmt.Errorf("lock variant stock: %w", e)
		}
		// A44 (owner decision 2026-10-14): never block a sale and never hide a
		// shortfall. Both paths record the true negative, flag the order and write a
		// per-line exception row below (same tx). Stock already <= 0 means the whole
		// line is short; each line sees the previous line's decrement, so the sum of
		// shortfalls over an order equals the total pushed below zero.
		next := stock - it.Quantity
		if short := shortfallOf(stock, it.Quantity); short > 0 {
			stockWarning = true
			before, after := stock, next
			stockExceptions = append(stockExceptions, pendingStockException{
				line: li, kind: write.StockExceptionShortage, shortfall: short,
				stockBefore: &before, stockAfter: &after,
			})
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

	err = tx.QueryRow(ctx, `
		INSERT INTO orders (
		  order_number, order_uuid, idempotency_key, device_id, outlet_id,
		  cashier_id, cashier_name, salesman_id, salesman_name,
		  customer_id, customer_name, subtotal, discount_amount, discount_type,
		  discount_value, discount_code, surcharge_type, surcharge_value,
		  surcharge_amount, tax_amount, total, payment_method, amount_paid,
		  change, status, notes, shift_id, client_created_at, quoted_total,
		  stock_warning, points_redeemed, points_redemption_amount, discount_label, discount_breakdown, points_earned, discount_warning, discount_warning_reason, applied_discount_codes, tender_warning, tender_warning_reason,
		  receipt_snapshot, quote_warning, quote_warning_reason,
		  replaces_order_id, business_date, correction_amount)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
		        $19,$20,$21,$22,$23,$24,'completed',$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34,$35,$36,$37::jsonb,$38,$39,$40::jsonb,$41,$42,
		        $43,$44::date,$45)
		RETURNING id`,
		orderNumber, in.OrderUUID, in.IdempotencyKey, nullUUID(in.DeviceID), in.OutletID,
		in.CashierID, in.CashierName, nullUUID(in.SalesmanID), nullStr(in.SalesmanName),
		nullUUID(in.CustomerID), nullStr(in.CustomerName),
		res.Subtotal, res.DiscountAmount, nullStr(string(in.ManualKind)),
		nullNum(in.ManualValue), nullStr(in.DiscountCode),
		nullStr(string(in.SurchargeKind)), nullNum(in.Surcharge), res.SurchargeAmount,
		res.TaxAmount, finalTotal, settle.PaymentMethod, amountPaid, change,
		nullStr(in.Notes), nullUUID(in.ShiftID), in.ClientCreated, quotedStored,
		stockWarning, pointsRedeemed, nullNum(redeemAmount), nullStr(in.DiscountLabel), nullJSONValue(in.DiscountBreakdown),
		finalEarned, discountWarning, nullStr(discountWarnReason), nullCodes(appliedCodes),
		tenderWarning, nullStr(tenderReason),
		nullBytes(snapStored), quoteReason != "", nullStr(quoteReason),
		nullUUID(in.ReplacesOrderID), nullStr(in.BusinessDate), correction,
	).Scan(&orderID)
	if err != nil {
		if isIdempotencyConflict(err) {
			return "", false, false, orderKeyConflict(err)
		}
		return "", false, false, fmt.Errorf("insert order: %w", err)
	}

	// C6: one order_tenders row per payment line (a single tender is one row), same tx.
	for _, r := range settle.Rows {
		if _, e := tx.Exec(ctx, `
			INSERT INTO order_tenders (order_id, seq, method, amount, tendered, change, reference)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			orderID, r.Seq, r.Method, r.Amount, r.Tendered, r.Change, nullStr(r.Reference)); e != nil {
			return "", false, false, fmt.Errorf("insert order tender: %w", e)
		}
	}

	// A44: item ids are generated here (not RETURNING) so exception rows can name
	// their order line without changing this Exec into a query.
	// C4a: per-line refund identity + allocated net. Never fails the sale: on any
	// allocator problem every line gets NULL and the order is whole-order-refund only.
	allocLines, allocOK := allocateOrderLines(in.Items, pricingIn, finalTotal)
	var groupKeys []string
	if allocOK {
		groupKeys = refundGroups(in.Items)
	}
	itemIDs := make([]string, len(in.Items))
	for i, it := range in.Items {
		itemIDs[i] = uuid.NewString()
		var lineNoArg, netArg any
		groupArg := any(nil)
		bundleCols := it.bundleColumns()
		if allocOK {
			lineNoArg, netArg = allocLines[i].lineNo, float64(allocLines[i].net)
			groupArg = nullStr(groupKeys[i])
		}
		if _, e := tx.Exec(ctx, `
			INSERT INTO order_items (id, order_id, product_id, product_name,
			  variant_size, price, quantity, subtotal, is_bundle,
			  line_no, net_amount, refund_group,
			  bundle_group, bundle_role, bundle_line, bundle_size, bundle_discount, bundle_promotion_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			itemIDs[i], orderID, it.ProductID, it.ProductName, it.VariantSize,
			it.Price, it.Quantity, it.Subtotal, it.IsBundle,
			lineNoArg, netArg, groupArg, bundleCols[0], bundleCols[1], bundleCols[2],
			bundleCols[3], bundleCols[4], bundleCols[5]); e != nil {
			return "", false, false, fmt.Errorf("insert item: %w", e)
		}
	}

	// A44: one exception row per short line, in the sale tx (a replay returns at the
	// processed_keys guard before any write; a lost same-key race rolls all of this back).
	channel := "direct"
	if in.Offline {
		channel = "sync"
	}
	for _, x := range stockExceptions {
		it := in.Items[x.line]
		if e := write.InsertSaleStockException(ctx, tx, write.SaleStockExceptionRow{
			OrderID: orderID, OrderItemID: itemIDs[x.line], OrderNumber: orderNumber,
			OutletID: in.OutletID, ProductID: it.ProductID, ProductName: it.ProductName,
			VariantSize: it.VariantSize, Kind: x.kind, Quantity: it.Quantity,
			StockBefore: x.stockBefore, StockAfter: x.stockAfter, Shortfall: x.shortfall,
			Channel: channel, CashierID: in.CashierID, CashierName: in.CashierName,
			ShiftID: in.ShiftID, DeviceID: in.DeviceID, SoldAt: pickSaleTime(nil, in.ClientCreated),
		}); e != nil {
			return "", false, false, e
		}
	}

	if e := recordSaleMovements(ctx, tx, orderID, orderNumber, in, itemIDs); e != nil {
		return "", false, false, e
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
				// Promo-reward lines (bundle freed units, BXGY giveaways) are IsReward with
				// an EMPTY RewardConditionID — they are fulfilled by resolveBundleLines /
				// resolveRewardLines, NOT loyalty. Loyalty product_reward lines always carry
				// a non-empty condition ID (rewardMenu is keyed by loyalty ConditionID), so
				// skipping the empty ones here drops no real loyalty audit — it only silences
				// the false "unfulfillable reward line" warn spam they used to trigger.
				if it.RewardConditionID == "" {
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
		if isIdempotencyConflict(e) {
			return "", false, false, orderKeyConflict(e)
		}
		return "", false, false, fmt.Errorf("record idempotency: %w", e)
	}
	return orderID, false, stockWarning, nil
}

// Default PostgreSQL names of the unique constraints that make an order
// idempotent (0001_init.sql: orders.order_uuid UNIQUE, orders.idempotency_key
// UNIQUE, processed_keys.idempotency_key PRIMARY KEY).
var idempotencyConstraints = map[string]bool{
	"orders_order_uuid_key":      true,
	"orders_idempotency_key_key": true,
	"processed_keys_pkey":        true,
}

// isIdempotencyConflict reports a unique violation on one of those constraints,
// i.e. a concurrent send of the same order won the race.
func isIdempotencyConflict(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && idempotencyConstraints[pg.ConstraintName]
}

// replayAfterConflict handles the loser of a same-key race: roll back, re-read the
// winner's committed key and answer exactly like the normal duplicate path. If the
// key is not visible yet, fail retryably (never as a rejection of an applied sale).
func (s *OrderService) replayAfterConflict(ctx context.Context, tx pgx.Tx, key string, cause error) (string, bool, bool, error) {
	_ = tx.Rollback(ctx)
	var existing string
	err := s.Pool.QueryRow(ctx,
		`SELECT order_id FROM processed_keys WHERE idempotency_key=$1`, key).Scan(&existing)
	if err == nil {
		return existing, true, false, nil
	}
	slog.Warn("order idempotency conflict without a replayable key", "idempotencyKey", key, "cause", cause, "err", err)
	return "", false, false, apperr.Wrap(apperr.Busy, write.ErrBusy)
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
