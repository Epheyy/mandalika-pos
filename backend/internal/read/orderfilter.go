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
	// DateFrom/DateTo are WIB (Asia/Jakarta) calendar days (YYYY-MM-DD) applied to
	// created_at; DateTo is inclusive (exclusive bound at day+1).
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

// wibDayStart is the SQL instant at which the WIB calendar day in placeholder $n
// begins. A28 will replace this one helper with a per-outlet timezone.
func wibDayStart(n int) string {
	return fmt.Sprintf("($%d::text::date)::timestamp AT TIME ZONE 'Asia/Jakarta'", n)
}

// wibDayEnd is the exclusive instant after the WIB calendar day in placeholder $n.
func wibDayEnd(n int) string {
	return fmt.Sprintf("(($%d::text::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta')", n)
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
		where += fmt.Sprintf(" AND o.created_at >= %s", wibDayStart(add(f.DateFrom)))
	}
	if f.DateTo != "" {
		where += fmt.Sprintf(" AND o.created_at < %s", wibDayEnd(add(f.DateTo)))
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

// wibDayInstant is the instant a WIB calendar day starts (Jakarta has no DST), used
// only to echo the applied window back in the summary response.
func wibDayInstant(day string, addDays int) (time.Time, error) {
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		return time.Time{}, err
	}
	wib := time.FixedZone("WIB", 7*3600)
	return time.Date(d.Year(), d.Month(), d.Day()+addDays, 0, 0, 0, 0, wib), nil
}

// appliedWindow reports the effective [from,to) instants of the date filters for the
// summary echo: the tighter of the WIB-day and legacy-instant bounds; nil = unbounded.
func (f OrderFilter) appliedWindow() (from, to *time.Time, err error) {
	from, to = f.FromInstant, f.ToInstant
	if f.DateFrom != "" {
		t, err := wibDayInstant(f.DateFrom, 0)
		if err != nil {
			return nil, nil, err
		}
		if from == nil || t.After(*from) {
			from = &t
		}
	}
	if f.DateTo != "" {
		t, err := wibDayInstant(f.DateTo, 1)
		if err != nil {
			return nil, nil, err
		}
		if to == nil || t.Before(*to) {
			to = &t
		}
	}
	return from, to, nil
}
