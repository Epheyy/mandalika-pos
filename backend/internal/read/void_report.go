package read

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// VoidReportReasons mirrors service.VoidReasonCode: read does not import service (it would invert
// the layering). A reasonCode filter outside this set is a 400 in the handler.
var VoidReportReasons = map[string]bool{
	"salah_metode_pembayaran": true, "salah_barang": true, "salah_promo": true, "salah_pelanggan": true,
	"transaksi_ganda": true, "transaksi_tes": true, "lainnya": true,
}

// VoidReportFilters bound the Pembatalan report ("" / nil = no filter). DateFrom/DateTo are business
// days of the ORIGINAL sale (orders.business_date). OutletID must already be scope-clamped by the
// caller. CashierID filters on the VOIDER (order_voids.voided_by); the seller is a column. Any
// void-specific filter (reason, voider, afterClose) leaves the legacy imports out: they carry none
// of those facts.
type VoidReportFilters struct {
	DateFrom, DateTo, OutletID, ReasonCode, CashierID string
	AfterClose                                        *bool
	Page, Limit                                       int
}

// voidReportSQL is ONE statement (one snapshot) so the page, its count, the totals and byReason
// always agree. $1 dateFrom, $2 dateTo, $3 outlet, $4 reasonCode, $5 voider, $6 afterClose
// (” | 'true' | 'false'), $7 limit, $8 offset.
//
// base = one row per voided sale (order_voids) plus one per legacy import (status='cancelled' with
// no void record). The effective replacement is the void's own (mode replace) or the followup's
// (Buat pengganti after a later void). state: replaced | awaiting_replacement (later, no followup) |
// no_replacement (marked, or mode none) | legacy.
//
// totals and byReason cover the whole filtered range, kind='void' only. replacementTotal counts
// the replacements still STANDING (status <> 'cancelled'): "money corrected". A replacement that
// was itself voided left its money out again and shows as its own void row (whose own replacement,
// if any, counts instead), so the invariant is replacementTotal = the sum of the rows'
// replacementTotal where the row's replacementStanding is true. correctionTotal counts the same
// live replacements: a voided replacement's correction was reversed with it. originalTotal counts
// every voided sale.
const voidReportSQL = `
WITH base AS (
  SELECT v.id AS void_id, o.id AS order_id, o.order_number, 'void'::text AS kind, o.business_date,
         ou.name AS outlet_name, o.cashier_name AS sold_by, v.voided_at AS ts, v.reason_code, v.note,
         v.voided_by_name, v.device_id, v.source, v.after_close, v.original_total, v.original_tenders,
         COALESCE(v.replacement_order_id, f.replacement_order_id) AS repl_id,
         CASE WHEN COALESCE(v.replacement_order_id, f.replacement_order_id) IS NOT NULL THEN 'replaced'
              WHEN f.kind = 'no_replacement' THEN 'no_replacement'
              WHEN v.mode = 'later' THEN 'awaiting_replacement'
              ELSE 'no_replacement' END AS state
    FROM order_voids v
    JOIN orders o ON o.id = v.order_id
    JOIN outlets ou ON ou.id = o.outlet_id
    LEFT JOIN order_void_followups f ON f.void_id = v.id
   WHERE ($1 = '' OR o.business_date >= $1::text::date)
     AND ($2 = '' OR o.business_date <= $2::text::date)
     AND ($3 = '' OR o.outlet_id::text = $3)
     AND ($4 = '' OR v.reason_code = $4)
     AND ($5 = '' OR v.voided_by::text = $5)
     AND ($6 = '' OR v.after_close = ($6 = 'true'))
  UNION ALL
  SELECT NULL, o.id, o.order_number, 'legacy_import', o.business_date, ou.name, o.cashier_name, o.created_at,
         NULL, NULL, NULL, NULL, NULL, false, o.total,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount) ORDER BY t.seq)
                     FROM order_tenders t WHERE t.order_id = o.id),
                  jsonb_build_array(jsonb_build_object('method', o.payment_method, 'amount', o.total))),
         NULL::uuid, 'legacy'
    FROM orders o
    JOIN outlets ou ON ou.id = o.outlet_id
   WHERE o.status = 'cancelled' AND o.void_id IS NULL
     AND $4 = '' AND $5 = '' AND $6 = ''
     AND ($1 = '' OR o.business_date >= $1::text::date)
     AND ($2 = '' OR o.business_date <= $2::text::date)
     AND ($3 = '' OR o.outlet_id::text = $3)
)
SELECT json_build_object(
  'count', (SELECT count(*) FROM base),
  'totals', (SELECT json_build_object(
      'voids', count(*), 'originalTotal', COALESCE(sum(b.original_total), 0),
      'replacementTotal', COALESCE(sum(ro.total) FILTER (WHERE ro.status <> 'cancelled'), 0),
      'correctionTotal', COALESCE(sum(ro.correction_amount) FILTER (WHERE ro.status <> 'cancelled'), 0))
    FROM base b LEFT JOIN orders ro ON ro.id = b.repl_id WHERE b.kind = 'void'),
  'byReason', COALESCE((SELECT json_agg(json_build_object(
      'reasonCode', g.reason_code, 'voids', g.voids, 'originalTotal', g.original_total)
      ORDER BY g.voids DESC, g.reason_code)
    FROM (SELECT reason_code, count(*) AS voids, sum(original_total) AS original_total
            FROM base WHERE kind = 'void' GROUP BY reason_code) g), '[]'::json),
  'rows', COALESCE((SELECT json_agg(p.obj ORDER BY p.ts DESC, p.order_id DESC) FROM (
      SELECT b.ts, b.order_id, jsonb_strip_nulls(jsonb_build_object(
        'orderId', b.order_id, 'orderNumber', b.order_number, 'kind', b.kind, 'state', b.state,
        'businessDate', b.business_date, 'outletName', b.outlet_name, 'soldByName', COALESCE(b.sold_by, ''),
        'voidedAt', CASE WHEN b.kind = 'void' THEN b.ts END, 'voidedByName', b.voided_by_name,
        'deviceId', b.device_id, 'source', b.source, 'reasonCode', b.reason_code, 'note', b.note,
        'afterClose', b.after_close, 'originalTotal', b.original_total, 'originalTenders', b.original_tenders,
        'replacementOrderId', b.repl_id, 'replacementOrderNumber', ro.order_number,
        'replacementTotal', ro.total, 'correctionAmount', ro.correction_amount,
        'replacementStanding', COALESCE(ro.status <> 'cancelled', false),
        'replacementTenders', (SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount) ORDER BY t.seq)
                                 FROM order_tenders t WHERE t.order_id = b.repl_id),
        'countedLines', CASE WHEN b.void_id IS NULL THEN 0 ELSE
           (SELECT count(*) FROM order_void_items i WHERE i.void_id = b.void_id AND i.counted_stock_count_id IS NOT NULL) END
      )) AS obj
        FROM base b LEFT JOIN orders ro ON ro.id = b.repl_id
       ORDER BY b.ts DESC, b.order_id DESC LIMIT $7 OFFSET $8) p), '[]'::json))`

// VoidReport returns the Pembatalan report: a page of voided sales (newest first) with the totals
// and per-reason breakdown over the whole filtered range, and the total row count for paging.
func (r *Repo) VoidReport(ctx context.Context, f VoidReportFilters) (api.VoidReport, int, error) {
	limit := f.Limit
	if limit < 1 {
		limit = 50
	}
	afterClose := ""
	if f.AfterClose != nil {
		afterClose = fmt.Sprintf("%t", *f.AfterClose)
	}
	var raw []byte
	if err := r.Pool.QueryRow(ctx, voidReportSQL, f.DateFrom, f.DateTo, f.OutletID, f.ReasonCode, f.CashierID,
		afterClose, limit, off(f.Page, limit)).Scan(&raw); err != nil {
		return api.VoidReport{}, 0, fmt.Errorf("void report: %w", err)
	}
	var out struct {
		Count    int                   `json:"count"`
		Totals   api.VoidReportTotals  `json:"totals"`
		ByReason []api.VoidReasonTotal `json:"byReason"`
		Rows     []api.VoidReportRow   `json:"rows"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return api.VoidReport{}, 0, fmt.Errorf("void report decode: %w", err)
	}
	return api.VoidReport{Data: out.Rows, Totals: out.Totals, ByReason: out.ByReason}, out.Count, nil
}
