package service

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrShiftOpen = errors.New("a shift is already open for this outlet")

type OpenShiftInput struct {
	OutletID     string
	OutletName   string
	CashierID    string
	CashierName  string
	StartingCash float64
}

// OpenShift creates an open shift; rejects a second concurrent open shift for
// the outlet.
func (s *OrderService) OpenShift(ctx context.Context, in OpenShiftInput) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM shifts WHERE outlet_id=$1 AND status='open'`,
		in.OutletID).Scan(&n); err != nil {
		return "", err
	}
	if n > 0 {
		return "", ErrShiftOpen
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO shifts (outlet_id, outlet_name, cashier_id, cashier_name,
		  status, opened_at, starting_cash)
		VALUES ($1,$2,$3,$4,'open',now(),$5) RETURNING id`,
		in.OutletID, nullStr(in.OutletName), in.CashierID, in.CashierName,
		in.StartingCash).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// CloseShift is server-reconciled: totals are recomputed from the shift's
// orders, never trusted from the client (plan §9 :875-882). Idempotent.
func (s *OrderService) CloseShift(ctx context.Context, outletID, shiftID string, closingCash float64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		shiftID, outletID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOrderClosed
	}
	if err != nil {
		return err
	}
	if status == "closed" {
		return tx.Commit(ctx)
	}
	_, err = tx.Exec(ctx, `
		UPDATE shifts s SET
		  status='closed', closed_at=now(), closing_cash=$3,
		  total_sales    = COALESCE(a.total_sales,0),
		  total_orders   = COALESCE(a.total_orders,0),
		  total_refunds  = COALESCE(a.total_refunds,0),
		  cash_sales     = COALESCE(a.cash_sales,0),
		  card_sales     = COALESCE(a.card_sales,0),
		  transfer_sales = COALESCE(a.transfer_sales,0),
		  qris_sales     = COALESCE(a.qris_sales,0)
		FROM (
		  SELECT
		    sum(total) FILTER (WHERE status='completed') AS total_sales,
		    count(*)   FILTER (WHERE status='completed') AS total_orders,
		    sum(total) FILTER (WHERE status='refunded')  AS total_refunds,
		    sum(total) FILTER (WHERE status='completed' AND payment_method='cash')     AS cash_sales,
		    sum(total) FILTER (WHERE status='completed' AND payment_method='card')     AS card_sales,
		    sum(total) FILTER (WHERE status='completed' AND payment_method='transfer') AS transfer_sales,
		    sum(total) FILTER (WHERE status='completed' AND payment_method='qris')     AS qris_sales
		  FROM orders WHERE shift_id=$1
		) a
		WHERE s.id=$1 AND s.outlet_id=$2`,
		shiftID, outletID, closingCash)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type CashFlowInput struct {
	OutletID    string
	ShiftID     string
	Type        string
	Amount      float64
	Description string
	CashierID   string
	CashierName string
}

func (s *OrderService) AddCashFlow(ctx context.Context, in CashFlowInput) (string, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO cash_flows (outlet_id, shift_id, type, amount, description,
		  cashier_id, cashier_name, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		in.OutletID, nullUUID(in.ShiftID), in.Type, in.Amount, in.Description,
		nullUUID(in.CashierID), nullStr(in.CashierName), time.Now()).Scan(&id)
	return id, err
}
