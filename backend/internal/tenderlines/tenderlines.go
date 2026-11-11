// Package tenderlines holds the SQL fragments that give a money reader an order's payment lines
// (C6a plan 2.1). It lives in its own tiny package because the shift code (package service) and
// the report/order readers (package read) both need it and neither imports the other.
//
// The rule "an order without stored lines is ONE synthetic line (payment_method, total)" is
// written in three places that must be kept in step: Lateral (per order, used by shift close and
// the order reads), SetLines (set-based, used by the report summary) and the SQL function
// order_default_payout_method (migration 0079). SP subtest 14 compares Lateral and SetLines on
// mixed fixtures.
package tenderlines

import (
	"fmt"
	"strings"
)

// Lateral joins one row per payment line of `orders o` as alias tl
// (seq, method, amount, tendered, change, reference, synthetic). An order written without
// stored lines (before C6a, by an old revision, or imported) gets ONE synthetic line
// (1, payment_method, total, amount_paid, change, NULL, true), which reproduces how every
// reader treated such an order before split payment: the whole total under its method.
// The fragment is per order (PK order_tenders(order_id, seq)); never wrap it in a global view.
// It costs two index probes per order: for a whole sale set use SetLines instead.
const Lateral = `
CROSS JOIN LATERAL (
  SELECT t.seq, t.method, t.amount, t.tendered, t.change, t.reference, false AS synthetic
    FROM order_tenders t WHERE t.order_id = o.id
  UNION ALL
  SELECT 1, o.payment_method, o.total, o.amount_paid, o.change, NULL, true
   WHERE NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = o.id)
) tl`

// SetLines renders the payment lines of every row of `base` (a table or CTE with the columns
// id, payment_method, total and every column named in keep) as one set: a LEFT JOIN LATERAL that
// probes order_tenders_pkey once per base row. A row with stored lines yields one row per line;
// a row without yields ONE synthetic row (payment_method, total, true), keyed on the lateral
// side's order_id being NULL (method and amount are NOT NULL in order_tenders). It yields the
// same (id, method, amount, synthetic) rows as Lateral, in the columns
// `id, <keep...>, method, amount, synthetic`.
//
// Why LATERAL and not a hash join plus anti-join: that form scanned all of order_tenders twice,
// so a report's cost grew with the table, not the window. The probe cost follows the window. A
// plain LEFT JOIN measured 5-10% faster at 1M orders but still scans the whole table.
// A method filter belongs on the caller's side: pushing it into the join measured slower (more
// buffers, no time gain) on a 200k-order seed.
func SetLines(base string, keep []string) string {
	cols := ""
	for _, c := range keep {
		cols += ", o." + c
	}
	return strings.TrimSpace(fmt.Sprintf(`
SELECT o.id%[2]s,
       CASE WHEN t.order_id IS NULL THEN o.payment_method ELSE t.method END AS method,
       CASE WHEN t.order_id IS NULL THEN o.total ELSE t.amount END AS amount,
       t.order_id IS NULL AS synthetic
  FROM %[1]s o LEFT JOIN LATERAL (SELECT t.order_id, t.method, t.amount
                                    FROM order_tenders t WHERE t.order_id = o.id) t ON true`,
		base, cols))
}
