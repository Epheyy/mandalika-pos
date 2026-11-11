package read

import (
	"context"
	"fmt"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

// GoodsReceiptFilter narrows the Barang Masuk list; empty fields match everything. From is
// inclusive and To exclusive (the handler resolves calendar days to instants).
type GoodsReceiptFilter struct {
	LocationType string // "outlet" | "warehouse"
	LocationID   string
	From, To     *time.Time
	Q            string // supplier, note, or an item's product name / SKU
	Source       string // "supply" | "warranty"
}

const goodsReceiptListObj = `json_build_object('id',gr.id,
  'locationType',CASE WHEN gr.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END,
  'locationId',COALESCE(gr.warehouse_id,gr.outlet_id),
  'locationName',COALESCE(w.name,o.name),
  'supplier',gr.supplier,'note',gr.note,'source',gr.source,'createdAt',gr.created_at,
  'createdByName',u.display_name,
  'lineCount',(SELECT count(*) FROM goods_receipt_items i WHERE i.receipt_id=gr.id)::int,
  'totalQty',COALESCE((SELECT sum(i.qty) FROM goods_receipt_items i WHERE i.receipt_id=gr.id),0)::int)`

// GoodsReceipts lists the goods receipts the scope may see, newest first. The scope rule is the
// document one: warehouse receipts are not outlet-bound, an outlet receipt needs its outlet.
func (r *Repo) GoodsReceipts(ctx context.Context, s Scope, f GoodsReceiptFilter, page, limit int) ([]api.GoodsReceiptListItem, int, error) {
	args := []any{s.CrossAll, s.OutletID}
	where := docScopeSQL("gr", 1, 2)
	arg := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	switch f.LocationType {
	case "warehouse":
		where += ` AND gr.warehouse_id IS NOT NULL`
	case "outlet":
		where += ` AND gr.outlet_id IS NOT NULL`
	}
	if f.LocationID != "" {
		where += fmt.Sprintf(` AND COALESCE(gr.warehouse_id,gr.outlet_id) = $%d::uuid`, arg(f.LocationID))
	}
	if f.From != nil {
		where += fmt.Sprintf(` AND gr.created_at >= $%d`, arg(*f.From))
	}
	if f.To != nil {
		where += fmt.Sprintf(` AND gr.created_at < $%d`, arg(*f.To))
	}
	if f.Source != "" {
		where += fmt.Sprintf(` AND gr.source = $%d`, arg(f.Source))
	}
	if f.Q != "" {
		n := arg(likePattern(f.Q))
		where += fmt.Sprintf(` AND (gr.supplier ILIKE $%[1]d OR gr.note ILIKE $%[1]d OR EXISTS (
	   SELECT 1 FROM goods_receipt_items qi
	   LEFT JOIN products qp ON qp.id = qi.product_id
	   LEFT JOIN product_variants qv ON qv.product_id = qi.product_id AND qv.size = qi.variant_size
	   WHERE qi.receipt_id = gr.id AND (qp.name ILIKE $%[1]d OR qv.sku ILIKE $%[1]d)))`, n)
	}
	sql, qargs := goodsReceiptsPageSQL(where, args, page, limit)
	return pagedCountJSON[api.GoodsReceiptListItem](ctx, r.Pool, sql, qargs...)
}

// goodsReceiptsPageSQL builds the id-first statement (see orderPageSQL) from the filter's WHERE
// and args: one statement gives the page and the real total, also for a page past the end. The
// count and the page ids read goods_receipts alone (the joins below are 1:1 lookups).
func goodsReceiptsPageSQL(where string, args []any, page, limit int) (string, []any) {
	n := len(args)
	sql := fmt.Sprintf(`WITH t AS (SELECT count(*) AS n FROM goods_receipts gr WHERE %[1]s),
	     pg AS (SELECT gr.id, gr.created_at FROM goods_receipts gr WHERE %[1]s
	             ORDER BY gr.created_at DESC, gr.id DESC LIMIT $%[2]d OFFSET $%[3]d)
	SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE %[4]s END, t.n
	  FROM t LEFT JOIN pg ON true
	  LEFT JOIN goods_receipts gr ON gr.id = pg.id
	  LEFT JOIN warehouses w ON w.id = gr.warehouse_id
	  LEFT JOIN outlets o ON o.id = gr.outlet_id
	  LEFT JOIN users u ON u.id = gr.created_by
	 ORDER BY pg.created_at DESC, pg.id DESC`,
		where, n+1, n+2, goodsReceiptListObj)
	return sql, append(append([]any{}, args...), limit, off(page, limit))
}
