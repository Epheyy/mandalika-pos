package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/mandalika/pos-backend/internal/apperr"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// openShiftIndex is the partial unique index (migration 0053) holding one open
// shift per outlet.
const openShiftIndex = "shifts_one_open_per_outlet_idx"

// ErrShiftNotInOutlet is returned when a client-supplied shiftId is malformed,
// unknown, or belongs to another outlet.
var ErrShiftNotInOutlet = apperr.New(apperr.Rejected, "shift tidak ditemukan di outlet ini")

// ValidateShiftOutlet checks a non-empty client shiftId belongs to outletID. The
// shift need not be open (late sales keep their original, closed shift). An empty
// shiftId is allowed and always valid.
func (s *OrderService) ValidateShiftOutlet(ctx context.Context, outletID, shiftID string) error {
	return validateShiftOutlet(ctx, s.Pool, outletID, shiftID)
}

// isCanonicalUUID accepts only the 36-char hyphenated form. Verified against
// PostgreSQL 18: its uuid input accepts the braced and bare-hex forms (which it
// normalizes) but rejects urn:uuid:, odd hyphenation and surrounding whitespace, and
// Go's uuid.Parse accepts urn:uuid: too, so a Parse-only check would turn that into a
// 500. Canonical-only is the strictest form both sides agree on.
func isCanonicalUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	_, err := uuid.Parse(s)
	return err == nil
}

func validateShiftOutlet(ctx context.Context, q rowQueryRower, outletID, shiftID string) error {
	if shiftID == "" {
		return nil
	}
	// An empty/non-uuid outlet (e.g. an admin on "all outlets" with no active outlet)
	// can own no shift; answer the same refusal instead of a uuid cast error.
	if !isCanonicalUUID(outletID) || !isCanonicalUUID(shiftID) {
		return ErrShiftNotInOutlet
	}
	var one int
	err := q.QueryRow(ctx, `SELECT 1 FROM shifts WHERE id=$1 AND outlet_id=$2`, shiftID, outletID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrShiftNotInOutlet
	}
	return err
}

var ErrShiftOpen = apperr.New(apperr.Conflict, "a shift is already open for this outlet")

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
	id, err := s.OpenShiftTx(ctx, tx, in)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// OpenShiftTx is OpenShift inside a caller-owned transaction.
func (s *OrderService) OpenShiftTx(ctx context.Context, tx pgx.Tx, in OpenShiftInput) (string, error) {
	// Serialize concurrent opens at one outlet: the count-then-insert below is a race
	// without it (A04). FOR NO KEY UPDATE still conflicts with itself, but not with
	// the FOR KEY SHARE every order/shift/cash_flow insert takes on this row, so
	// sales are never blocked by an open. Nothing else locks outlets, so there is no
	// lock-order cycle with the transfer paths (transfer row, then stock rows).
	var locked int
	switch err := tx.QueryRow(ctx, `SELECT 1 FROM outlets WHERE id=$1 FOR NO KEY UPDATE`, in.OutletID).Scan(&locked); {
	case errors.Is(err, pgx.ErrNoRows):
		return "", apperr.New(apperr.NotFound, "outlet tidak ditemukan")
	case err != nil:
		return "", err
	}
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
	err := tx.QueryRow(ctx, `
		INSERT INTO shifts (outlet_id, outlet_name, cashier_id, cashier_name,
		  status, opened_at, starting_cash)
		VALUES ($1,$2,$3,$4,'open',now(),$5) RETURNING id`,
		in.OutletID, nullStr(in.OutletName), in.CashierID, in.CashierName,
		in.StartingCash).Scan(&id)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == openShiftIndex {
			return "", ErrShiftOpen
		}
		return "", err
	}
	return id, nil
}

// CloseShift is server-reconciled: totals are recomputed from the shift's
// orders, never trusted from the client (plan §9 :875-882). Idempotent.
// counted is the optional per-method cash the cashier physically counted at
// close (reconciliation "Terhitung"); nil/empty leaves any existing value
// untouched so a re-close (idempotent retry) never wipes it.
func (s *OrderService) CloseShift(ctx context.Context, outletID, shiftID string, closingCash float64, counted map[string]float64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.CloseShiftTx(ctx, tx, outletID, shiftID, closingCash, counted); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CloseShiftTx is CloseShift inside a caller-owned transaction.
func (s *OrderService) CloseShiftTx(ctx context.Context, tx pgx.Tx, outletID, shiftID string, closingCash float64, counted map[string]float64) error {
	var countedJSON []byte
	if len(counted) > 0 {
		b, err := json.Marshal(counted)
		if err != nil {
			return err
		}
		countedJSON = b
	}

	var status string
	err := tx.QueryRow(ctx,
		`SELECT status FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		shiftID, outletID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOrderClosed
	}
	if err != nil {
		return err
	}
	if status == "closed" {
		return nil
	}
	cashIDs, err := shiftCashMethodIDs(ctx, tx, shiftID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE shifts s SET
		  status='closed', closed_at=now(), closing_cash=$3,
		  counted_by_method = COALESCE($4::jsonb, s.counted_by_method),
		  total_sales    = COALESCE(a.total_sales,0),
		  total_orders   = COALESCE(a.total_orders,0),
		  total_refunds  = COALESCE(a.total_refunds,0),
		  cash_sales     = COALESCE(a.cash_sales,0),
		  card_sales     = COALESCE(a.card_sales,0),
		  transfer_sales = COALESCE(a.transfer_sales,0),
		  qris_sales     = COALESCE(a.qris_sales,0),
		  refunds_paid_by_method = r.by_method,
		  cash_refunds_paid      = r.cash_paid
		FROM (
		  -- C4a: sale side counts partially_refunded as a sale. Like a fully refunded order
		  -- (already out of total_sales, in total_refunds), a part-refunded order enters the
		  -- sales buckets NET of what has been refunded on it (net_sale), so
		  -- total_sales + total_refunds stays gross and expected cash = sales buckets minus
		  -- other-shift refunds paid still balances. total_refunds attributes to the SALE's
		  -- shift (orders.shift_id), whichever shift paid the refund.
		  SELECT
		    sum(net_sale) FILTER (WHERE is_sale) AS total_sales,
		    count(*)      FILTER (WHERE is_sale) AS total_orders,
		    sum(refunded)                        AS total_refunds,
		    sum(net_sale) FILTER (WHERE is_sale AND payment_method = ANY($5::text[])) AS cash_sales,
		    sum(net_sale) FILTER (WHERE is_sale AND payment_method='card' AND NOT (payment_method = ANY($5::text[])))     AS card_sales,
		    sum(net_sale) FILTER (WHERE is_sale AND payment_method='transfer' AND NOT (payment_method = ANY($5::text[]))) AS transfer_sales,
		    sum(net_sale) FILTER (WHERE is_sale AND payment_method='qris' AND NOT (payment_method = ANY($5::text[])))     AS qris_sales
		  FROM (
		    SELECT o.payment_method,
		           o.status IN ('completed','partially_refunded') AS is_sale,
		           x.refunded,
		           CASE WHEN o.status='completed' THEN o.total
		                WHEN o.status='partially_refunded' THEN GREATEST(o.total - x.refunded, 0) END AS net_sale
		      FROM orders o
		      CROSS JOIN LATERAL (SELECT COALESCE(sum(r.amount),0) AS refunded
		                            FROM order_refunds r WHERE r.order_id = o.id) x
		     WHERE o.shift_id=$1
		  ) ord
		) a,
		-- A06/Q2b: refunds this shift paid out for sales of OTHER shifts. A refund of
		-- this shift's own sale is already out of its sales and in total_refunds, so
		-- it is excluded here (no double subtraction). Late refunds (after close)
		-- never touch this snapshot. C4a: read from order_refunds (shift_id = the
		-- REFUNDING shift), one row per refund, so a partial refund counts too.
		(
		  SELECT COALESCE(jsonb_object_agg(payment_method, amount), '{}'::jsonb) AS by_method,
		         COALESCE(sum(amount) FILTER (WHERE payment_method = ANY($5::text[])), 0) AS cash_paid
		  FROM (
		    SELECT r.payment_method, sum(r.amount) AS amount
		      FROM order_refunds r JOIN orders o ON o.id = r.order_id
		     WHERE r.shift_id=$1 AND o.shift_id IS DISTINCT FROM $1
		     GROUP BY r.payment_method
		  ) x
		) r
		WHERE s.id=$1 AND s.outlet_id=$2`,
		shiftID, outletID, closingCash, countedJSON, cashIDs)
	return err
}

// shiftCashMethodIDs lists the payment method ids on this shift's completed orders,
// and on refunds this shift paid out (order_refunds.shift_id), that are cash at close time
// (the flag in force now decides; closed shifts are a snapshot and never change).
// The UPDATE aggregates cash_sales and cash_refunds_paid and excludes these ids from
// the card/transfer/qris buckets, so nothing is counted twice. Custom non-cash
// methods land in no bucket. Always non-nil: a NULL array would make the FILTER
// predicates NULL.
func shiftCashMethodIDs(ctx context.Context, tx pgx.Tx, shiftID string) ([]string, error) {
	settings, err := loadAppSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx,
		`SELECT payment_method FROM orders
		  WHERE shift_id=$1 AND status IN ('completed','partially_refunded')
		 UNION
		 SELECT payment_method FROM order_refunds WHERE shift_id=$1`, shiftID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var method string
		if err := rows.Scan(&method); err != nil {
			return nil, err
		}
		if IsCashMethod(settings.PaymentMethods, method) {
			ids = append(ids, method)
		}
	}
	return ids, rows.Err()
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
	return addCashFlow(ctx, s.Pool, in)
}

// AddCashFlowTx is AddCashFlow inside a caller-owned transaction.
func (s *OrderService) AddCashFlowTx(ctx context.Context, tx pgx.Tx, in CashFlowInput) (string, error) {
	return addCashFlow(ctx, tx, in)
}

func addCashFlow(ctx context.Context, q rowQueryRower, in CashFlowInput) (string, error) {
	var id string
	err := q.QueryRow(ctx, `
		INSERT INTO cash_flows (outlet_id, shift_id, type, amount, description,
		  cashier_id, cashier_name, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		in.OutletID, nullUUID(in.ShiftID), in.Type, in.Amount, in.Description,
		nullUUID(in.CashierID), nullStr(in.CashierName), time.Now()).Scan(&id)
	return id, err
}
