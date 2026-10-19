package read

import (
	"fmt"
	"strings"
	"time"
)

// OrderFilter is the single filter shared by the orders list and the report
// summary, so a summary and its list/CSV always cover exactly the same rows (A26).
// Every field is optional. Scope must come from the request's scope(r), never from
// a raw outletId query parameter.
type OrderFilter struct {
	Scope Scope
	// DateFrom/DateTo are business days (YYYY-MM-DD) compared with orders.business_date,
	// which migration 0059 stamps in the OUTLET's timezone (a shift's sales take the shift's
	// opening day). Both bounds are inclusive and need no timezone math at read time.
	DateFrom, DateTo string
	Status           string
	// PaymentMethod is matched case-insensitively after trimming; grouping elsewhere
	// stays on the raw value.
	PaymentMethod string
	Q             string
	ShiftID       string
	CustomerID    string
	// LegacyFrom/LegacyTo keep the POS /orders contract byte-for-byte: a plain
	// created_at >= from, and created_at < to::date + 1 day (UTC-day semantics).
	LegacyFrom, LegacyTo string
	// FromInstant/ToInstant are the legacy /reports/summary instants: [from, to).
	FromInstant, ToInstant *time.Time
}

// buildOrderWhere returns a WHERE clause over `orders o` and its positional args.
func buildOrderWhere(f OrderFilter) (string, []any) {
	where := "WHERE 1=1"
	args := []any{}
	add := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	if !f.Scope.CrossAll {
		where += fmt.Sprintf(" AND o.outlet_id=$%d", add(f.Scope.OutletID))
	}
	if f.ShiftID != "" {
		where += fmt.Sprintf(" AND o.shift_id=$%d", add(f.ShiftID))
	}
	if f.CustomerID != "" {
		where += fmt.Sprintf(" AND o.customer_id=$%d", add(f.CustomerID))
	}
	if f.LegacyFrom != "" {
		where += fmt.Sprintf(" AND o.created_at >= $%d", add(f.LegacyFrom))
	}
	if f.LegacyTo != "" {
		where += fmt.Sprintf(" AND o.created_at < ($%d::date + interval '1 day')", add(f.LegacyTo))
	}
	if f.FromInstant != nil {
		where += fmt.Sprintf(" AND o.created_at >= $%d", add(*f.FromInstant))
	}
	if f.ToInstant != nil {
		where += fmt.Sprintf(" AND o.created_at < $%d", add(*f.ToInstant))
	}
	if f.DateFrom != "" {
		where += fmt.Sprintf(" AND o.business_date >= $%d::text::date", add(f.DateFrom))
	}
	if f.DateTo != "" {
		where += fmt.Sprintf(" AND o.business_date <= $%d::text::date", add(f.DateTo))
	}
	if f.Status != "" {
		where += fmt.Sprintf(" AND o.status=$%d", add(f.Status))
	}
	if f.PaymentMethod != "" {
		where += fmt.Sprintf(" AND lower(btrim(o.payment_method)) = lower(btrim($%d))", add(f.PaymentMethod))
	}
	if f.Q != "" {
		n := add("%" + f.Q + "%")
		// Match order number, cashier name, the order's stored customer name, or the
		// linked customer's phone/name.
		where += strings.ReplaceAll(` AND (o.order_number ILIKE $N OR o.cashier_name ILIKE $N
		  OR o.customer_name ILIKE $N
		  OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
		    AND (c.phone ILIKE $N OR c.name ILIKE $N)))`, "$N", fmt.Sprintf("$%d", n))
	}
	return where, args
}

// appliedWindow reports the legacy [from,to) instants for the summary echo; nil = not given.
// The business-day bounds are echoed separately as dateFrom/dateTo (they are not instants).
func (f OrderFilter) appliedWindow() (from, to *time.Time) {
	return f.FromInstant, f.ToInstant
}
