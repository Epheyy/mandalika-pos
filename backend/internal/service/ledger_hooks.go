package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/ledger"
)

// recordRefundMovements writes the stock ledger rows of one refund, in the refund's
// transaction, right after RefundTx returned nil (see RefundTxLedger). It selects the
// lines RefundTx restocked: every order line without an unresolved_variant exception
// row (the sale moved no stock for it) that has an outlet stock row NOW. RefundTx
// restocks a line when its variant OR its stock row exists and upserts the row, so
// after RefundTx a restocked line always has a stock row, and a line it skipped as
// "not live" (neither exists) still has none: the post-RefundTx row test is
// equivalent to RefundTx's live test. The order is RefundTx's own, so a repeated
// (product, size) chains in the order the deltas were applied. Qty is the line
// quantity as RefundTx upserted it (a legacy negative one is recorded as is; the
// ledger skips only zero). Plain reads only: RefundTx already holds the stock locks.
func recordRefundMovements(ctx context.Context, tx pgx.Tx, in RefundInput) error {
	var orderNumber string
	if err := tx.QueryRow(ctx, `SELECT order_number FROM orders WHERE id=$1`, in.OrderID).Scan(&orderNumber); err != nil {
		return err
	}
	rows, err := tx.Query(ctx,
		`SELECT oi.id::text, oi.product_id::text, oi.variant_size, oi.quantity
		   FROM order_items oi
		  WHERE oi.order_id=$1
		    AND NOT EXISTS (SELECT 1 FROM sale_stock_exceptions x
		                     WHERE x.order_item_id = oi.id AND x.kind = 'unresolved_variant')
		    AND EXISTS (SELECT 1 FROM outlet_variant_stock s
		                 WHERE s.outlet_id = $2 AND s.product_id = oi.product_id AND s.variant_size = oi.variant_size)
		  ORDER BY oi.product_id, oi.variant_size, oi.id`,
		in.OrderID, in.OutletID)
	if err != nil {
		return err
	}
	defer rows.Close()
	doc := ledger.Document{
		Key: "refund:" + in.OrderID, Kind: ledger.KindRefund,
		LocationType: ledger.LocOutlet, LocationID: in.OutletID,
		RefType: "order", RefID: in.OrderID, RefNumber: orderNumber, Actor: in.UserID,
		OccurredAt: time.Now(),
	}
	for rows.Next() {
		var itemID, pid, size string
		var qty int
		if err := rows.Scan(&itemID, &pid, &size, &qty); err != nil {
			return err
		}
		doc.Lines = append(doc.Lines, ledger.Line{
			ProductID: pid, VariantSize: size, Qty: qty, RefLine: itemID,
			DedupeKey:          "refund:" + itemID,
			RefundOfMovementID: ledger.MovementID("sale:" + itemID),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	_, err = ledger.RecordDeltas(ctx, tx, doc)
	return err
}
