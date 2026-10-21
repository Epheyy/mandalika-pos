package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

// Refund flips a completed order to refunded and restores stock (Orders.tsx:47-72).
// Refunding an already-refunded or non-completed order is refused (A06).
func (s *OrderService) Refund(ctx context.Context, in RefundInput) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.RefundTx(ctx, tx, in); err != nil {
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

// RefundTx is Refund inside a caller-owned transaction (the caller commits or
// rolls back). Used by the keyed /sync/batch path so the refund and its
// operation receipt commit atomically.
func (s *OrderService) RefundTx(ctx context.Context, tx pgx.Tx, in RefundInput) error {
	outletID, orderID := in.OutletID, in.OrderID
	reason, err := NormalizeRefund(orderID, in.Reason)
	if err != nil {
		return err
	}
	var status, orderNumber string
	var custID *string
	var discountCode *string
	var appliedCodes []string
	var oEarned, oRedeemed int
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
		return ErrRefundOrderNotFound
	}
	if err != nil {
		return err
	}
	preRestore := preCodes
	if len(preRestore) == 0 && preDiscountCode != nil && *preDiscountCode != "" {
		preRestore = []string{*preDiscountCode}
	}
	lockedCodes, err := lockCodes(ctx, tx, preRestore, false)
	if err != nil {
		return err
	}
	if preCust != nil && *preCust != "" {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM customers WHERE id=$1 FOR UPDATE`, *preCust); err != nil {
			return fmt.Errorf("lock customer for refund: %w", err)
		}
	}
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed, &discountCode, &appliedCodes)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRefundOrderNotFound
	}
	if err != nil {
		return err
	}
	if (custID == nil) != (preCust == nil) || (custID != nil && *custID != *preCust) {
		return apperr.Wrap(apperr.Busy, write.ErrBusy) // customer moved by a merge mid-refund
	}
	// A06/Q1: a second refund is a second payout. Refuse it (the batch path turns
	// this into a review item); same-key replays never get here (receipt replay).
	if status == "refunded" {
		return ErrAlreadyRefunded
	}
	if status != "completed" {
		return ErrOrderNotRefundable
	}
	if _, err = tx.Exec(ctx,
		`UPDATE orders SET status='refunded', refund_reason=$1, refunded_at=now(),
		        refund_shift_id=NULLIF($3::text,'')::uuid,
		        refunded_by=NULLIF($4::text,'')::uuid,
		        refunded_by_name=NULLIF($5::text,'')
		   WHERE id=$2`, reason, orderID, in.ShiftID, in.UserID, in.UserName); err != nil {
		return err
	}
	// SP-Promo-3a: restore usage for EVERY applied code. Fall back to the singular
	// discount_code for pre-feature orders (applied_discount_codes is NULL there).
	// GREATEST(-1,0) + the completed-only check keep this at most once.
	restore := appliedCodes
	if len(restore) == 0 && discountCode != nil && *discountCode != "" {
		restore = []string{*discountCode}
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
				return fmt.Errorf("restore discount usage: %w", err)
			}
		}
	}
	// A44: restock exactly what the sale decremented. A line the sale skipped (no
	// variant at sale time, recorded as unresolved_variant) is never restocked, and a
	// line whose variant AND outlet stock row are gone (catalog delete removes both) is skipped and recorded instead of
	// recreating an orphan stock row (or failing the refund on the stock FK).
	rows, err := tx.Query(ctx,
		`SELECT oi.id, oi.product_id, oi.variant_size, oi.quantity, oi.is_bundle,
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
		return err
	}
	type ri struct {
		itemID, pid, size           string
		qty                         int
		isBundle, saleSkipped, live bool
	}
	var restock []ri
	for rows.Next() {
		var r ri
		if err := rows.Scan(&r.itemID, &r.pid, &r.size, &r.qty, &r.isBundle, &r.saleSkipped, &r.live); err != nil {
			rows.Close()
			return err
		}
		restock = append(restock, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range restock {
		if r.saleSkipped {
			continue // the sale moved no stock for this line (its exception row says so)
		}
		if !r.live {
			// Never restock a gone variant (it would orphan a stock row or hit the
			// stock->products FK). Bundles were skipped silently at sale time, and a
			// legacy qty<=0 line cannot satisfy the exception CHECK, so neither is recorded.
			if !r.isBundle && r.qty > 0 {
				if err := write.InsertRefundUnresolvedVariant(ctx, tx, r.itemID, in.Channel); err != nil {
					return err
				}
			}
			continue
		}
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
	// restore redeemed. Runs at most once per order: only a completed order gets here.
	// SP-CRM-8: orders.points_earned now stores the FULL engine total (base × mult +
	// bonuses), so this clawback reverses bonuses too with no change here. Condition
	// application rows are immutable order-time facts and are intentionally not reversed.
	if custID != nil && *custID != "" {
		// The customer row was locked above (global lock order); this re-lock is a no-op
		// that reads the balance the clawback below is computed from.
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

	// A15 Phase B: the restock above is stock changing under every tablet at this
	// outlet. Exactly once per refund transaction, LAST (the caller's receipt UPDATE
	// afterwards touches no stock or version row). Counted even when every line was
	// skipped: the refund committed, and a stray extra pull is harmless.
	if _, e := write.BumpStockSeq(ctx, tx, outletID); e != nil {
		return e
	}
	return nil
}
