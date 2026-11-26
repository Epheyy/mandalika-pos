package service

import (
	"context"
	"errors"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// maxCrossRefundDeviceRunes bounds the tablet device id (same cap as the sync envelope).
const maxCrossRefundDeviceRunes = 128

// CrossOutletOutcome is the result of RefundCrossOutlet: the refund plus where the order lives.
type CrossOutletOutcome struct {
	RefundResult
	SaleOutletID string
}

// RefundCrossOutlet is the online-only A18 return: a sale made at another outlet, refunded and paid out at
// in.OutletID (Y) from Y's open shift in.ShiftID. One transaction; the same RefundLinesTx guards apply.
//
// Lock-order note: the shift row is taken FOR SHARE first. The only writer that locks a shift row FOR UPDATE
// is shift close (shift.go), which takes no A42 lock (codes, customer, order, stock), so taking the shift row
// before RefundLinesTx's A42 order cannot form a cycle. Other shift writers only take FK KEY SHARE, which does
// not conflict with FOR SHARE. The share lock closes the race with Y's close: either the close waits and its
// aggregate sees this refund, or this refund sees status 'closed' and is refused before any money moves.
func (s *OrderService) RefundCrossOutlet(ctx context.Context, in RefundInput) (CrossOutletOutcome, error) {
	if n := utf8.RuneCountInString(in.DeviceID); n < 1 || n > maxCrossRefundDeviceRunes || !IsCanonicalUUID(in.ClientRefundUUID) {
		return CrossOutletOutcome{}, ErrCrossRefundKeyRequired
	}
	// NormalizeRefund also rejects a malformed order id before it reaches SQL.
	if _, err := NormalizeRefund(in.OrderID, in.Reason); err != nil {
		return CrossOutletOutcome{}, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return CrossOutletOutcome{}, err
	}
	defer tx.Rollback(ctx)

	// Replay probe. A retry of a refund that is already committed must answer with the original outcome
	// even after Y's shift closed, so a hit only skips the open-shift check below; the order lookup
	// still runs because the order lives at X, not at Y.
	replay := false
	var probeOrder string
	err = tx.QueryRow(ctx,
		`SELECT order_id::text FROM order_refunds WHERE device_id=$1 AND client_refund_uuid=$2::uuid`,
		in.DeviceID, in.ClientRefundUUID).Scan(&probeOrder)
	switch {
	case err == nil:
		if probeOrder != in.OrderID {
			return CrossOutletOutcome{}, ErrRefundOrderMismatch
		}
		replay = true
	case !errors.Is(err, pgx.ErrNoRows):
		return CrossOutletOutcome{}, err
	}

	var saleOutlet string
	err = tx.QueryRow(ctx, `SELECT outlet_id::text FROM orders WHERE id=$1`, in.OrderID).Scan(&saleOutlet)
	if errors.Is(err, pgx.ErrNoRows) {
		return CrossOutletOutcome{}, ErrRefundOrderNotFound
	}
	if err != nil {
		return CrossOutletOutcome{}, err
	}
	// A replay is never refused for outlet reasons: a Manajer covering X and Y can resend a committed Y
	// payout with X active, and the tablet must get the original outcome (RefundLinesTx's replay
	// returns before writing anything, and resolves the order at its sale outlet).
	if !replay && saleOutlet == in.OutletID {
		return CrossOutletOutcome{}, ErrCrossRefundSameOutlet
	}

	if !replay {
		if !IsCanonicalUUID(in.ShiftID) {
			return CrossOutletOutcome{}, ErrCrossRefundShift
		}
		var one int
		err = tx.QueryRow(ctx,
			`SELECT 1 FROM shifts WHERE id=$1::uuid AND outlet_id=$2 AND status='open' FOR SHARE`,
			in.ShiftID, in.OutletID).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return CrossOutletOutcome{}, ErrCrossRefundShift
		}
		if err != nil {
			return CrossOutletOutcome{}, err
		}
	}

	in.SaleOutletID = saleOutlet
	in.Channel = "direct" // 0055: sync|direct only
	res, err := s.RefundLinesTx(ctx, tx, in)
	if err != nil {
		return CrossOutletOutcome{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CrossOutletOutcome{}, err
	}
	return CrossOutletOutcome{RefundResult: res, SaleOutletID: saleOutlet}, nil
}
