package read

import (
	"fmt"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/phone"
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
	// CustomerSearch lets Q also match customer names and phone substrings (callers with
	// customer access to everyone). The zero value is the restricted form (A30): Q matches
	// the order number, the cashier name, or the exact normalized phone of the linked customer.
	CustomerSearch bool
	ShiftID        string
	CustomerID     string
	// LegacyFrom/LegacyTo keep the POS /orders contract byte-for-byte: a plain
	// created_at >= from, and created_at < to::date + 1 day (UTC-day semantics).
	LegacyFrom, LegacyTo string
	// FromInstant/ToInstant are the legacy /reports/summary instants: [from, to).
	FromInstant, ToInstant *time.Time
	// DateBasis selects which day DateFrom/DateTo (and the summary's instants) bound:
	// "" or "sale" = the sale (business_date / created_at); "refund" = the refund
	// (order_refunds.refund_business_date / refunded_at), and then only orders with at least one
	// refund row match (A27, C4a: this includes partially refunded orders).
	// LegacyFrom/LegacyTo always stay on created_at (POS contract).
	DateBasis string
}

// refundBasis reports whether the filter reads the refund side.
func (f OrderFilter) refundBasis() bool { return f.DateBasis == "refund" }

// buildOrderWhere returns a WHERE clause over `orders o` and its positional args.
func buildOrderWhere(f OrderFilter) (string, []any) {
	return appendOrderWhere(f, []any{}, false)
}

// appendOrderWhere builds the same clause but numbers its placeholders after the args
// already collected, so two clauses (sale set and refund set) share one statement.
//
// C4a: on the refund basis the day/instant bounds and the "has a refund" requirement apply to
// order_refunds rows (alias r), not to orders. refundRows=false (the orders list) renders them
// as one EXISTS over the order's refund rows, so an order with several refunds appears once
// and one refund row must satisfy every bound; refundRows=true (the summary's refund set)
// expects the caller to FROM orders o JOIN order_refunds r ON r.order_id=o.id and renders them
// as plain conditions on r, giving one row per refund.
func appendOrderWhere(f OrderFilter, args []any, refundRows bool) (string, []any) {
	where := "WHERE 1=1"
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
	if f.refundBasis() {
		// Same row must satisfy "exists" and every bound, hence one conjunction.
		rc := ""
		if f.FromInstant != nil {
			rc += fmt.Sprintf(" AND r.refunded_at >= $%d", add(*f.FromInstant))
		}
		if f.ToInstant != nil {
			rc += fmt.Sprintf(" AND r.refunded_at < $%d", add(*f.ToInstant))
		}
		if f.DateFrom != "" {
			rc += fmt.Sprintf(" AND r.refund_business_date >= $%d::text::date", add(f.DateFrom))
		}
		if f.DateTo != "" {
			rc += fmt.Sprintf(" AND r.refund_business_date <= $%d::text::date", add(f.DateTo))
		}
		if refundRows {
			where += rc
		} else {
			where += " AND EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id" + rc + ")"
		}
	} else {
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
	}
	if f.Status != "" {
		where += fmt.Sprintf(" AND o.status=$%d", add(f.Status))
	}
	if f.PaymentMethod != "" {
		where += fmt.Sprintf(" AND lower(btrim(o.payment_method)) = lower(btrim($%d))", add(f.PaymentMethod))
	}
	if f.Q != "" {
		n := add("%" + f.Q + "%")
		if f.CustomerSearch {
			// Order number, cashier name, the order's stored customer name, or the
			// linked customer's phone/name.
			where += strings.ReplaceAll(` AND (o.order_number ILIKE $N OR o.cashier_name ILIKE $N
		  OR o.customer_name ILIKE $N
		  OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
		    AND (c.phone ILIKE $N OR c.name ILIKE $N)))`, "$N", fmt.Sprintf("$%d", n))
		} else {
			clause := ` AND (o.order_number ILIKE $N OR o.cashier_name ILIKE $N`
			if norm := phone.Normalize(f.Q); norm != "" {
				clause += fmt.Sprintf(` OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
		    AND c.phone_norm = $%d)`, add(norm))
			}
			where += strings.ReplaceAll(clause+`)`, "$N", fmt.Sprintf("$%d", n))
		}
	}
	return where, args
}

// appliedWindow reports the legacy [from,to) instants for the summary echo; nil = not given.
// The business-day bounds are echoed separately as dateFrom/dateTo (they are not instants).
func (f OrderFilter) appliedWindow() (from, to *time.Time) {
	return f.FromInstant, f.ToInstant
}
