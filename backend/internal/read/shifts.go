package read

import (
	"context"
	"fmt"

	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/rules"
)

const shiftObj = `json_build_object('id',s.id,'outletId',s.outlet_id,'businessDate',s.business_date,
  'outletName',s.outlet_name,'cashierId',s.cashier_id,'cashierName',s.cashier_name,
  'status',s.status,'openedAt',s.opened_at,'closedAt',s.closed_at,
  'startingCash',s.starting_cash,'startingCashWarning',(s.starting_cash_warning OR s.starting_cash < 0),'closingCash',s.closing_cash,
  'totalSales',s.total_sales,'totalOrders',s.total_orders,
  'totalRefunds',s.total_refunds,'cashSales',s.cash_sales,'cardSales',s.card_sales,
  'transferSales',s.transfer_sales,'qrisSales',s.qris_sales,
  'countedByMethod',s.counted_by_method,
  -- Closed: the close-time snapshot (NULL before 0047). Open: filled in Go from the
  -- live refundsPaidByMethod, because the isCash rule lives in rules.IsCashMethod.
  'cashRefundsPaid',CASE WHEN s.status='closed' AND s.refunds_paid_by_method IS NOT NULL THEN s.cash_refunds_paid END,
  'refundsPaidByMethod',CASE WHEN s.status='closed' THEN s.refunds_paid_by_method
    ELSE (SELECT COALESCE(jsonb_object_agg(x.payment_method, x.amount),'{}'::jsonb) FROM (
      SELECT r.payment_method, sum(r.amount) AS amount
        FROM order_refunds r JOIN orders o ON o.id = r.order_id
       WHERE r.shift_id=s.id AND o.shift_id IS DISTINCT FROM s.id
       GROUP BY r.payment_method) x) END)`

// Shifts lists shifts newest first. dateFrom/dateTo are business days compared with
// shifts.business_date (a shift's opening day in its outlet's zone, owner rule A28).
func (r *Repo) Shifts(ctx context.Context, sc Scope, dateFrom, dateTo string, page, limit int) ([]api.Shift, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		where += fmt.Sprintf(" AND s.outlet_id=$%d", len(args))
	}
	if dateFrom != "" {
		args = append(args, dateFrom)
		where += fmt.Sprintf(" AND s.business_date >= $%d::text::date", len(args))
	}
	if dateTo != "" {
		args = append(args, dateTo)
		where += fmt.Sprintf(" AND s.business_date <= $%d::text::date", len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM shifts s %s
	  ORDER BY s.opened_at DESC, s.id DESC LIMIT $%d OFFSET $%d`,
		shiftObj, where, len(args)-1, len(args))
	rows, total, err := listJSON[api.Shift](ctx, r.Pool, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	if err := r.fillOpenCashRefunds(ctx, rows); err != nil {
		return nil, 0, err
	}
	return rows, total, r.fillShiftCorrections(ctx, rows)
}

// fillOpenCashRefunds sets cashRefundsPaid on open shifts: the cash part of the live
// refundsPaidByMethod, by the same isCash rule CloseShiftTx snapshots at close.
func (r *Repo) fillOpenCashRefunds(ctx context.Context, shifts []api.Shift) error {
	var methods []api.PaymentMethodConfig
	loaded := false
	for i := range shifts {
		if shifts[i].Status != api.ShiftStatusOpen {
			continue
		}
		if !loaded {
			s, err := r.AppSettings(ctx)
			if err != nil {
				return err
			}
			methods, loaded = s.PaymentMethods, true
		}
		var cash float64
		if by, err := shifts[i].RefundsPaidByMethod.Get(); err == nil {
			for method, amount := range by {
				if rules.IsCashMethod(methods, method) {
					cash += float64(amount)
				}
			}
		}
		shifts[i].CashRefundsPaid = nullable.NewNullableWithValue(cash)
	}
	return nil
}

func (r *Repo) oneShift(ctx context.Context, sql string, args ...any) (api.Shift, error) {
	s, err := oneJSON[api.Shift](ctx, r.Pool, sql, args...)
	if err != nil {
		return s, err
	}
	one := []api.Shift{s}
	if err := r.fillOpenCashRefunds(ctx, one); err != nil {
		return s, err
	}
	if err := r.fillShiftCorrections(ctx, one); err != nil {
		return s, err
	}
	return one[0], nil
}

func (r *Repo) Shift(ctx context.Context, sc Scope, id string) (api.Shift, error) {
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$2"
	}
	return r.oneShift(ctx,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.id=$1`+cond, args...)
}

// CurrentShift returns the open shift for the active outlet, or ErrNotFound.
func (r *Repo) CurrentShift(ctx context.Context, sc Scope) (api.Shift, error) {
	args := []any{}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$1"
	}
	return r.oneShift(ctx,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.status='open'`+cond+
			` ORDER BY s.opened_at DESC LIMIT 1`, args...)
}

func (r *Repo) CashFlows(ctx context.Context, s Scope, shiftID string, page, limit int) ([]api.CashFlow, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !s.CrossAll {
		args = append(args, s.OutletID)
		where += fmt.Sprintf(" AND cf.outlet_id=$%d", len(args))
	}
	if shiftID != "" {
		args = append(args, shiftID)
		where += fmt.Sprintf(" AND cf.shift_id=$%d", len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT json_build_object('id',cf.id,'outletId',cf.outlet_id,
	  'shiftId',cf.shift_id,'type',cf.type,'amount',cf.amount,
	  'description',cf.description,'cashierId',cf.cashier_id,
	  'cashierName',cf.cashier_name,'createdAt',cf.created_at),
	  count(*) OVER() AS total FROM cash_flows cf %s
	  ORDER BY cf.created_at DESC, cf.id DESC LIMIT $%d OFFSET $%d`,
		where, len(args)-1, len(args))
	return listJSON[api.CashFlow](ctx, r.Pool, sql, args...)
}
