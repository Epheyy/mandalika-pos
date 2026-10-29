// Package tenderlines holds the single SQL fragment every money reader uses to see
// an order's payment lines (C6a plan 2.1). It lives in its own tiny package because the
// shift code (package service) and the report/order readers (package read) both need it
// and neither imports the other.
package tenderlines

// Lateral joins one row per payment line of `orders o` as alias tl
// (seq, method, amount, tendered, change, reference, synthetic). An order written without
// stored lines (before C6a, by an old revision, or imported) gets ONE synthetic line
// (1, payment_method, total, amount_paid, change, NULL, true), which reproduces how every
// reader treated such an order before split payment: the whole total under its method.
// The fragment is per order (PK order_tenders(order_id, seq)); never wrap it in a global view.
const Lateral = `
CROSS JOIN LATERAL (
  SELECT t.seq, t.method, t.amount, t.tendered, t.change, t.reference, false AS synthetic
    FROM order_tenders t WHERE t.order_id = o.id
  UNION ALL
  SELECT 1, o.payment_method, o.total, o.amount_paid, o.change, NULL, true
   WHERE NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = o.id)
) tl`
