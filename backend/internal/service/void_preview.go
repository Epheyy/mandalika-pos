package service

import (
	"context"
	"errors"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// VoidPreview says what a void of this sale would do: whether it is allowed for the caller, and the
// stock lines an approved stock count already covered (the user must choose for each). It is
// read-only and takes no locks. "Own shift" here means the original's shift is the outlet's open
// shift (there is one per outlet) and the caller has void_own_shift: the preview has no envelope.
func (s *OrderService) VoidPreview(ctx context.Context, outletID, orderID string, in VoidInput) (api.VoidPreview, error) {
	out := api.VoidPreview{Lines: []api.VoidPreviewLine{}}
	if _, err := uuid.Parse(orderID); err != nil {
		return out, ErrVoidNotFound
	}
	if _, err := uuid.Parse(outletID); err != nil {
		return out, ErrVoidNotFound
	}
	var o voidOrderRow
	err := s.Pool.QueryRow(ctx,
		`SELECT status, order_number, customer_id::text, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb), round(total)::bigint, payment_method,
		        device_id::text, shift_id::text, void_id::text, created_at, business_date::text
		   FROM orders WHERE id=$1 AND outlet_id=$2`, orderID, outletID).
		Scan(&o.status, &o.orderNumber, &o.custID, &o.earned, &o.redeemed, &o.discountCode, &o.appliedCodes,
			&o.total, &o.paymentMethod, &o.deviceID, &o.shiftID, &o.voidID, &o.createdAt, &o.businessDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrVoidNotFound
	}
	if err != nil {
		return out, err
	}
	var openShift string
	if err := s.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT id::text FROM shifts WHERE outlet_id=$1 AND status='open'), '')`, outletID).Scan(&openShift); err != nil {
		return out, err
	}
	in.OutletID, in.OrderID, in.Source, in.CallerShiftID = outletID, orderID, VoidSourcePOS, openShift
	facts, err := loadVoidFacts(ctx, s.Pool, false, in, o)
	if err != nil {
		return out, err
	}
	out.WindowDays = facts.WindowDays
	out.AfterClose = facts.ShiftStatus == "closed"

	refuse := func(e error) {
		msg := e.Error()
		out.Refusal = &msg
	}
	if e := checkVoidEligible(facts); e != nil {
		refuse(e)
	} else if authority, e := decideVoidAuthority(facts, in); e != nil {
		refuse(e)
	} else {
		a := api.VoidPreviewAuthority(authority)
		out.Authority, out.Eligible = &a, true
		// Amounts are editable only for an own-shift void while the sale's shift is still open.
		out.AmountsLocked = !(authority == VoidOwnShift && facts.ShiftStatus == "open")
	}

	rows, err := s.Pool.Query(ctx,
		`SELECT m.dedupe_key, m.product_id::text, COALESCE(p.name,''), m.variant_size, -m.qty
		   FROM stock_movements m LEFT JOIN products p ON p.id = m.product_id
		  WHERE m.kind='sale' AND m.ref_type='order' AND m.ref_id=$1 AND m.qty < 0
		  ORDER BY m.product_id, m.variant_size, m.dedupe_key`, orderID)
	if err != nil {
		return out, err
	}
	type line struct {
		key, pid, name, size string
		qty                  int
	}
	var lines []line
	for rows.Next() {
		var l line
		if err := rows.Scan(&l.key, &l.pid, &l.name, &l.size, &l.qty); err != nil {
			rows.Close()
			return out, err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, l := range lines {
		pl := api.VoidPreviewLine{Key: l.key, ProductId: openapi_types.UUID(uuid.MustParse(l.pid)), ProductName: l.name, VariantSize: l.size, Quantity: l.qty}
		counted, err := voidCountedAfter(ctx, s.Pool, outletID, l.pid, l.size, o.createdAt)
		if err != nil {
			return out, err
		}
		if counted != "" {
			pl.CountedAfter = true
			var name string
			if err := s.Pool.QueryRow(ctx, `SELECT name FROM stock_counts WHERE id=$1`, counted).Scan(&name); err == nil {
				pl.StockCountName = &name
			}
		}
		out.Lines = append(out.Lines, pl)
	}
	return out, nil
}
