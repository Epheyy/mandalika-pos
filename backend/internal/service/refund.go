package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/write"
)

// Refund is the direct-route whole-order refund (legacy shape: no items): it flips a
// completed order to refunded and restores stock (Orders.tsx:47-72). Refunding an
// already-refunded or non-completed order is refused (A06).
func (s *OrderService) Refund(ctx context.Context, in RefundInput) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := s.RefundLinesTx(ctx, tx, in); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// OrderOutlet returns the outlet an order belongs to, so an admin without an
// active outlet can refund it there. A missing order is ErrRefundOrderNotFound.
func (s *OrderService) OrderOutlet(ctx context.Context, orderID string) (string, error) {
	if _, err := NormalizeRefund(orderID, "x"); err != nil {
		return "", err
	}
	var outlet string
	err := s.Pool.QueryRow(ctx, `SELECT outlet_id::text FROM orders WHERE id=$1`, orderID).Scan(&outlet)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrRefundOrderNotFound
	}
	return outlet, err
}

// RefundResult is the outcome of one refund, returned to the sync layer for the ack.
type RefundResult struct {
	RefundID    string
	OrderStatus string // orders.status after the refund: partially_refunded | refunded
	// RefundState is "full" iff this refund left the order refunded, else "partial" (the
	// sync ack's refundState; a tablet that sees "full" marks the order fully refunded).
	RefundState string
	Amount      int64 // amount of record, whole rupiah
	Replayed    bool  // a UNIQUE(device_id, client_refund_uuid) replay: nothing was written
}

// refundOrder is the order row as RefundLinesTx reads it under its lock.
type refundOrder struct {
	status, orderNumber, paymentMethod string
	custID, discountCode               *string
	appliedCodes                       []string
	earned, redeemed, total            int64
}

// restockLine is one refunded line whose units go back to stock (and into the ledger).
type restockLine struct {
	ItemID, ProductID, Size string
	Qty                     int
}

// RefundLinesTx is THE refund, used by both payload shapes inside a caller-owned
// transaction (the caller commits or rolls back; the keyed /sync/batch path commits it with
// its operation receipt). The legacy whole-order refund (in.Items == nil) is the "all lines"
// case of the same code: every unit, amount = orders.total, scope 'full'.
//
// Lock order (A42, unchanged): discount codes -> customer -> the order row FOR UPDATE ->
// (stock rows, in product/size order) -> BumpStockSeq last. The order lock serialises every
// refund of one order, so the over-refund guard below cannot race.
//
// WRITE ORDER IS LOAD-BEARING: the order_refunds row is INSERTed BEFORE orders.status is
// UPDATEd. Migration 0077's trigger orders_refunded_legacy_row inserts a 'legacy_full'
// seq=1 refund row when an order becomes 'refunded' with no refund row; inserting ours first
// makes the trigger a no-op, inserting it after would collide on UNIQUE(order_id, seq).
func (s *OrderService) RefundLinesTx(ctx context.Context, tx pgx.Tx, in RefundInput) (RefundResult, error) {
	outletID, orderID := in.OutletID, in.OrderID
	reason, err := NormalizeRefund(orderID, in.Reason)
	if err != nil {
		return RefundResult{}, err
	}
	reasonCode, err := ValidateRefundExtras(in.Items, in.ReasonCode)
	if err != nil {
		return RefundResult{}, err
	}
	payoutAsked, err := ValidateRefundPayoutMethod(in.PayoutMethod)
	if err != nil {
		return RefundResult{}, err
	}
	// A42: enter the global lock order (codes -> customer -> stock) BEFORE locking the
	// order row. The order's codes are immutable and its customer only changes by a
	// merge, so read them unlocked, lock codes then customer, then lock the order and
	// verify the customer did not move (a concurrent merge): if it did, nothing has
	// been applied and the caller's retry re-runs the whole refund.
	var preCust *string
	var preDiscountCode *string
	var preCodes []string
	err = tx.QueryRow(ctx,
		`SELECT customer_id, discount_code, COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2`,
		orderID, outletID).Scan(&preCust, &preDiscountCode, &preCodes)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefundResult{}, ErrRefundOrderNotFound
	}
	if err != nil {
		return RefundResult{}, err
	}
	preRestore := preCodes
	if len(preRestore) == 0 && preDiscountCode != nil && *preDiscountCode != "" {
		preRestore = []string{*preDiscountCode}
	}
	lockedCodes, err := lockCodes(ctx, tx, preRestore, false)
	if err != nil {
		return RefundResult{}, err
	}
	if preCust != nil && *preCust != "" {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM customers WHERE id=$1 FOR UPDATE`, *preCust); err != nil {
			return RefundResult{}, fmt.Errorf("lock customer for refund: %w", err)
		}
	}
	var o refundOrder
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb), round(total)::bigint, payment_method
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&o.status, &o.orderNumber, &o.custID, &o.earned, &o.redeemed,
		&o.discountCode, &o.appliedCodes, &o.total, &o.paymentMethod)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefundResult{}, ErrRefundOrderNotFound
	}
	if err != nil {
		return RefundResult{}, err
	}
	if (o.custID == nil) != (preCust == nil) || (o.custID != nil && *o.custID != *preCust) {
		return RefundResult{}, apperr.Wrap(apperr.Busy, write.ErrBusy) // customer moved by a merge mid-refund
	}

	// Replay defence in depth (the A11 receipt is the primary guard): the same tablet refund
	// uuid already recorded here is a no-op success with the original outcome. Runs before the
	// status checks because the replayed refund may itself have completed the order.
	if in.DeviceID != "" && in.ClientRefundUUID != "" {
		res, found, rerr := replayedRefund(ctx, tx, orderID, in.DeviceID, in.ClientRefundUUID, o.status)
		if rerr != nil {
			return RefundResult{}, rerr
		}
		if found {
			return res, nil
		}
	}

	// A06/Q1: a second whole refund is a second payout. Refuse it (the batch path turns this
	// into a review item); same-key replays never get here (receipt replay).
	if o.status == "refunded" {
		return RefundResult{}, ErrAlreadyRefunded
	}
	if o.status != "completed" && o.status != "partially_refunded" {
		return RefundResult{}, ErrOrderNotRefundable
	}
	var refundCount, maxSeq int
	var priorComputed, priorAmount, prevClawed, prevRestored int64
	if err := tx.QueryRow(ctx,
		`SELECT count(*), COALESCE(max(seq),0), COALESCE(sum(round(computed_amount)),0)::bigint,
		        COALESCE(sum(round(amount)),0)::bigint, COALESCE(sum(points_clawed),0)::bigint,
		        COALESCE(sum(points_restored),0)::bigint
		   FROM order_refunds WHERE order_id=$1`, orderID).
		Scan(&refundCount, &maxSeq, &priorComputed, &priorAmount, &prevClawed, &prevRestored); err != nil {
		return RefundResult{}, err
	}
	if in.Items == nil {
		// Legacy shape: only a completed order that has no refund yet. On a part-refunded order
		// it must NEVER mean "refund the remainder" (the old dialog showed the full total, which
		// may already be paid out): conflict into review.
		if o.status == "partially_refunded" {
			return RefundResult{}, ErrRefundPartialNeedsNewApp
		}
		if refundCount > 0 {
			return RefundResult{}, ErrOrderNotRefundable // completed with refund rows: inconsistent, refuse
		}
	}

	// A44: restock exactly what the sale decremented. A line the sale skipped (no variant at
	// sale time, recorded as unresolved_variant) is never restocked, and a line whose variant
	// AND outlet stock row are gone (catalog delete removes both) is skipped and recorded.
	// ORDER BY is the stock-row apply order: keep it.
	rows, err := tx.Query(ctx,
		`SELECT oi.id::text, oi.line_no, round(oi.net_amount)::bigint, round(oi.subtotal)::bigint,
		        COALESCE(oi.refund_group,''), oi.quantity,
		        COALESCE((SELECT sum(ri.quantity) FROM order_refund_items ri WHERE ri.order_item_id = oi.id), 0)::bigint,
		        oi.product_id::text, oi.variant_size, oi.is_bundle,
		        EXISTS (SELECT 1 FROM sale_stock_exceptions x
		                 WHERE x.order_item_id = oi.id AND x.kind = 'unresolved_variant'),
		        (EXISTS (SELECT 1 FROM product_variants pv
		                  WHERE pv.product_id = oi.product_id AND pv.size = oi.variant_size)
		         OR EXISTS (SELECT 1 FROM outlet_variant_stock s
		                     WHERE s.outlet_id = $2 AND s.product_id = oi.product_id AND s.variant_size = oi.variant_size))
		   FROM order_items oi WHERE oi.order_id=$1
		  ORDER BY oi.product_id, oi.variant_size, oi.id`,
		orderID, outletID)
	if err != nil {
		return RefundResult{}, err
	}
	var lines []refundLine
	for rows.Next() {
		var l refundLine
		if err := rows.Scan(&l.ID, &l.LineNo, &l.Net, &l.Subtotal, &l.Group, &l.Qty, &l.Prior,
			&l.ProductID, &l.VariantSize, &l.IsBundle, &l.SaleSkipped, &l.VariantLive); err != nil {
			rows.Close()
			return RefundResult{}, err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return RefundResult{}, err
	}
	picks, completes, err := planRefund(lines, in.Items)
	if err != nil {
		return RefundResult{}, err
	}

	computed := refundComputedAmount(picks, completes, o.total, priorComputed)
	claimed := in.RefundAmount
	if in.Items == nil {
		// The legacy payload carries no amount: the whole order's total, exactly as before C4.
		claimed = nil
	}
	amount, amountWarning, claimedKept := ResolveRefundAmount(claimed, computed, priorAmount, o.total)

	// Points (D-37), computed now (the customer row is locked) and applied after the order
	// writes: the cumulative proportional share of the computed value refunded so far (the
	// completing refund settles exactly), minus what earlier refunds actually took. The floor
	// at 0 applies per refund; a shortfall is not lost: the next refund's target minus what was actually taken re-claws it.
	var clawed, restored, afterClaw, newBal int64
	var forgiven int64
	if o.custID != nil && *o.custID != "" {
		var bal int
		if e := tx.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, *o.custID).Scan(&bal); e != nil {
			return RefundResult{}, fmt.Errorf("load points for refund: %w", e)
		}
		cum := priorComputed + computed
		clawWant := max(ClawTarget(o.earned, cum, o.total, completes)-prevClawed, 0)
		clawed = int64(write.PointsClawback(bal, int(clawWant)))
		forgiven = clawWant - clawed
		restored = max(ClawTarget(o.redeemed, cum, o.total, completes)-prevRestored, 0)
		afterClaw = int64(bal) - clawed
		newBal = afterClaw + restored
	}

	payoutMethod, payoutSource, err := resolveRefundPayout(ctx, tx, orderID, o.paymentMethod, payoutAsked)
	if err != nil {
		return RefundResult{}, err
	}

	refundID := uuid.NewString()
	// Write order: refund row, its items, THEN orders.status (see the doc comment).
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_refunds (id, order_id, outlet_id, seq, scope, amount, computed_amount, claimed_amount, amount_warning,
		        payment_method, reason, reason_code, shift_id, refunded_by, refunded_by_name,
		        device_id, client_refund_uuid, ledger_document_key, points_clawed, points_restored, payout_source)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11,NULLIF($12,''),NULLIF($13::text,'')::uuid,
		        NULLIF($14::text,'')::uuid,NULLIF($15,''),NULLIF($16,''),NULLIF($17::text,'')::uuid,$18,$19,$20,$21)`,
		refundID, orderID, outletID, maxSeq+1, refundScope(completes, refundCount), amount, computed, claimedKept, amountWarning,
		payoutMethod, reason, reasonCode, in.ShiftID, in.UserID, in.UserName,
		in.DeviceID, in.ClientRefundUUID, "refund:"+refundID, clawed, restored, payoutSource); err != nil {
		return RefundResult{}, fmt.Errorf("insert order_refunds: %w", err)
	}

	// Per refunded line: the item row, and a restock candidate unless the sale moved no stock.
	var moved []restockLine
	for _, p := range picks {
		l := lines[p.Index]
		restocked := false
		switch {
		case l.SaleSkipped:
			// the sale moved no stock for this line (its exception row says so)
		case !l.VariantLive:
			// Never restock a gone variant (it would orphan a stock row or hit the
			// stock->products FK). Bundles were skipped silently at sale time, and a
			// legacy qty<=0 line cannot satisfy the exception CHECK, so neither is recorded.
			if !l.IsBundle && l.Qty > 0 {
				if err := write.InsertRefundUnresolvedVariant(ctx, tx, l.ID, in.Channel); err != nil {
					return RefundResult{}, err
				}
			}
		default:
			restocked = true
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO order_refund_items (refund_id, order_item_id, quantity, amount, restocked)
			 VALUES ($1,$2,$3,$4,$5)`, refundID, l.ID, p.Qty, p.Amount, restocked); err != nil {
			return RefundResult{}, fmt.Errorf("insert order_refund_items: %w", err)
		}
		if restocked {
			moved = append(moved, restockLine{ItemID: l.ID, ProductID: l.ProductID, Size: l.VariantSize, Qty: int(p.Qty)})
		}
	}

	// Order status. Only the refund that completes the order writes the single-valued
	// orders.refund_* columns (old readers/clients keep working); the 0059 trigger then stamps
	// refund_business_date. A part refund only flips the status.
	newStatus := "partially_refunded"
	if completes {
		newStatus = "refunded"
		_, err = tx.Exec(ctx,
			`UPDATE orders SET status='refunded', refund_reason=$1, refunded_at=now(),
			        refund_shift_id=NULLIF($3::text,'')::uuid,
			        refunded_by=NULLIF($4::text,'')::uuid,
			        refunded_by_name=NULLIF($5::text,'')
			   WHERE id=$2`, reason, orderID, in.ShiftID, in.UserID, in.UserName)
	} else {
		_, err = tx.Exec(ctx, `UPDATE orders SET status='partially_refunded' WHERE id=$1`, orderID)
	}
	if err != nil {
		return RefundResult{}, err
	}

	// SP-Promo-3a / D-38: restore code usage only on the refund that completes the order; a
	// part-refunded order still holds its slot. Fall back to the singular discount_code for
	// pre-feature orders (applied_discount_codes is NULL there). GREATEST(-1,0) and the
	// single-completion rule keep this at most once.
	if completes {
		restore := o.appliedCodes
		if len(restore) == 0 && o.discountCode != nil && *o.discountCode != "" {
			restore = []string{*o.discountCode}
		}
		// Restore in the order the rows were locked (the database's code order, not Go's
		// byte order); a code applied twice is restored twice, as before.
		restoreCount := make(map[string]int, len(restore))
		for _, code := range restore {
			if code != "" {
				restoreCount[code]++
			}
		}
		for _, code := range lockedCodes {
			for i := 0; i < restoreCount[code]; i++ {
				if _, err = tx.Exec(ctx,
					`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`,
					code); err != nil {
					return RefundResult{}, fmt.Errorf("restore discount usage: %w", err)
				}
			}
		}
	}
	for _, m := range moved {
		if _, err = tx.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			   VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			outletID, m.ProductID, m.Size, m.Qty); err != nil {
			return RefundResult{}, err
		}
	}

	// Points ledger rows + balance (SP-CRM-7/8): earned is the FULL engine total (bonuses
	// included), so the proportional claw covers them. Condition application rows are
	// immutable order-time facts and are intentionally not reversed.
	if o.custID != nil && *o.custID != "" {
		if clawed > 0 {
			clawReason := fmt.Sprintf("Pembatalan poin dari refund %s", o.orderNumber)
			if forgiven > 0 {
				clawReason += fmt.Sprintf(" (%d poin tidak cukup saldo, ditagih di refund berikutnya jika ada)", forgiven)
			}
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *o.custID, Type: "refund", Points: -int(clawed),
				BalanceAfter: int(afterClaw), Reason: clawReason, OrderID: orderID,
			}); e != nil {
				return RefundResult{}, fmt.Errorf("ledger refund clawback: %w", e)
			}
		}
		if restored > 0 {
			if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
				CustomerID: *o.custID, Type: "refund", Points: int(restored),
				BalanceAfter: int(newBal),
				Reason:       fmt.Sprintf("Pengembalian poin tukar dari refund %s", o.orderNumber),
				OrderID:      orderID,
			}); e != nil {
				return RefundResult{}, fmt.Errorf("ledger refund restore: %w", e)
			}
		}
		if clawed > 0 || restored > 0 {
			if _, e := tx.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, *o.custID, int(newBal)); e != nil {
				return RefundResult{}, fmt.Errorf("update points on refund: %w", e)
			}
		}
		// D-42: give back the COMPUTED share of spend (floor 0); visit_count stays (the visit happened).
		// Not the claimed amount: a bad client claim (flagged over_total) must never erase spend that
		// belongs to other orders and drive the customer tier; cash, reports and the ERP tender keep
		// the amount of record (D-39).
		if _, e := tx.Exec(ctx,
			`UPDATE customers SET total_spent = GREATEST(total_spent - $2, 0) WHERE id=$1`,
			*o.custID, computed); e != nil {
			return RefundResult{}, fmt.Errorf("reverse customer total_spent: %w", e)
		}
	}

	// Ledger rows of the restock: plain reads and ledger inserts, no stock or version lock.
	if err := recordRefundMovements(ctx, tx, in, refundID, o.orderNumber, moved); err != nil {
		return RefundResult{}, err
	}
	// A15 Phase B: the restock above is stock changing under every tablet at this outlet.
	// Exactly once per refund transaction, LAST (stockseq_guard_test enforces it; the caller's
	// receipt UPDATE afterwards touches no stock or version row). Counted even when every line
	// was skipped: the refund committed, and a stray extra pull is harmless.
	if _, e := write.BumpStockSeq(ctx, tx, outletID); e != nil {
		return RefundResult{}, e
	}

	state := "partial"
	if completes {
		state = "full"
	}
	return RefundResult{RefundID: refundID, OrderStatus: newStatus, RefundState: state, Amount: amount}, nil
}

// replayedRefund finds an earlier refund of this order recorded for the same (device, client
// refund uuid) and rebuilds its outcome. The uuid is unique across orders, so a row on a
// different order is a mismatch, never a replay. RefundState is "full" iff that refund is the
// latest one and the order is now refunded (it then is the one that completed it).
func replayedRefund(ctx context.Context, tx pgx.Tx, orderID, deviceID, clientUUID, orderStatus string) (RefundResult, bool, error) {
	var id, rOrder string
	var seq, maxSeq int
	var amount int64
	err := tx.QueryRow(ctx,
		`SELECT r.id::text, r.order_id::text, r.seq, round(r.amount)::bigint,
		        (SELECT max(seq) FROM order_refunds WHERE order_id = r.order_id)
		   FROM order_refunds r WHERE r.device_id=$1 AND r.client_refund_uuid=$2::uuid`,
		deviceID, clientUUID).Scan(&id, &rOrder, &seq, &amount, &maxSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefundResult{}, false, nil
	}
	if err != nil {
		return RefundResult{}, false, err
	}
	if rOrder != orderID {
		return RefundResult{}, false, ErrRefundOrderMismatch
	}
	state := "partial"
	if orderStatus == "refunded" && seq == maxSeq {
		state = "full"
	}
	return RefundResult{RefundID: id, OrderStatus: orderStatus, RefundState: state, Amount: amount, Replayed: true}, true, nil
}
