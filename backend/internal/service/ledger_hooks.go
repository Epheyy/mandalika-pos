package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/ledger"
)

// recordRefundMovements writes the stock ledger rows of one refund, in the refund's
// transaction, after RefundLinesTx restocked and bumped the stock seq. moved lists exactly
// the lines it restocked (refunded quantity only; sale-skipped and gone-variant lines are
// excluded), in the order the stock deltas were applied, so a repeated (product, size) chains
// in that order. C4a keys: the document is "refund:<refundId>" (matches
// order_refunds.ledger_document_key) and each line "refund:<refundId>:<orderItemId>", so
// several refunds of one order never collide; RefundOfMovementID stays the sale's movement.
// Legacy whole-order refunds keep their "refund:<orderId>" keys and are never re-recorded.
// Plain reads and ledger inserts only: RefundLinesTx already holds the stock locks.
func recordRefundMovements(ctx context.Context, tx pgx.Tx, in RefundInput, refundID, orderNumber string, moved []restockLine) error {
	doc := ledger.Document{
		Key: "refund:" + refundID, Kind: ledger.KindRefund,
		LocationType: ledger.LocOutlet, LocationID: in.OutletID,
		RefType: "order", RefID: in.OrderID, RefNumber: orderNumber, Actor: in.UserID,
		OccurredAt: time.Now(),
	}
	for _, m := range moved {
		doc.Lines = append(doc.Lines, ledger.Line{
			ProductID: m.ProductID, VariantSize: m.Size, Qty: m.Qty, RefLine: m.ItemID,
			DedupeKey:          "refund:" + refundID + ":" + m.ItemID,
			RefundOfMovementID: ledger.MovementID("sale:" + m.ItemID),
		})
	}
	_, err := ledger.RecordDeltas(ctx, tx, doc)
	return err
}

// recordSaleMovements writes the stock ledger rows of one sale, in the sale's
// transaction, from the single call inside createOrderCore (D10). It runs after the
// order, items and exception rows exist and before processed_keys / BumpStockSeq, so a
// replay or a lost same-key race never reaches it or rolls it back. A line moved stock
// iff it has no unresolved_variant exception row and an outlet_variant_stock row exists
// now for (outlet, product, size): the core loop decrements every line whose row exists
// by exactly its quantity, and a non-bundle line without a row always has an unresolved
// exception. The one theoretical gap is bundle-only: a bundle line the sale skipped for
// lack of a variant whose variant and stock row another transaction creates before this
// read would look moved; the invariant gate would surface it.
// The lines come from SQL scoped to this order, so product ids are the canonical
// product_id::text (a client id spelled differently still matches) and the read is one
// query. Current stock is read with a plain SELECT (this tx already holds the row
// locks); lines are ordered by their index in itemIDs (the application order) and
// walked backwards per key (after = current, before = after + qty), so a repeated
// (product, size) chains in item order. shortage is flagged when after < 0, which is the
// core loop's shortfallOf(stock, qty) > 0 (for qty > 0, stock < qty).
// Takes no locks and never writes stock.
func recordSaleMovements(ctx context.Context, tx pgx.Tx, orderID, orderNumber string, in CreateOrderInput, itemIDs []string) error {
	type key struct{ pid, size string }
	type moved struct {
		idx          int
		pid, size    string
		qty, current int
	}
	index := make(map[string]int, len(itemIDs))
	for i, id := range itemIDs {
		index[id] = i
	}
	rows, err := tx.Query(ctx,
		`SELECT oi.id::text, oi.product_id::text, oi.variant_size, oi.quantity, s.stock
		   FROM order_items oi
		   JOIN outlet_variant_stock s ON s.outlet_id = $2 AND s.product_id = oi.product_id AND s.variant_size = oi.variant_size
		  WHERE oi.order_id = $1
		    AND NOT EXISTS (SELECT 1 FROM sale_stock_exceptions x
		                     WHERE x.order_item_id = oi.id AND x.kind = 'unresolved_variant')`,
		orderID, in.OutletID)
	if err != nil {
		return fmt.Errorf("record sale movements: %w", err)
	}
	var ms []moved
	for rows.Next() {
		var id string
		var m moved
		if err := rows.Scan(&id, &m.pid, &m.size, &m.qty, &m.current); err != nil {
			rows.Close()
			return fmt.Errorf("record sale movements: %w", err)
		}
		m.idx = index[id]
		ms = append(ms, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("record sale movements: %w", err)
	}
	sort.Slice(ms, func(a, b int) bool { return ms[a].idx < ms[b].idx })
	cur := make(map[key]int, len(ms))
	for _, m := range ms {
		cur[key{m.pid, m.size}] = m.current
	}
	lines := make([]ledger.Line, len(ms))
	for i := len(ms) - 1; i >= 0; i-- {
		m := ms[i]
		k := key{m.pid, m.size}
		after := cur[k]
		before := after + m.qty
		cur[k] = before
		l := ledger.Line{
			ProductID: m.pid, VariantSize: m.size, Qty: -m.qty,
			QtyBefore: before, QtyAfter: after,
			DedupeKey: "sale:" + itemIDs[m.idx], RefLine: itemIDs[m.idx],
		}
		if after < 0 {
			l.Flags = []string{"shortage"}
		}
		lines[i] = l
	}
	// The giveaway line goes LAST so a sold or reward line on the same (product, size)
	// chains before it (Record keeps caller order within a key). It must come after the
	// sale-line read above: that read already includes the core loop's decrement.
	gl, err := giveawayLine(ctx, tx, orderID, in.OutletID)
	if err != nil {
		return fmt.Errorf("record sale movements: %w", err)
	}
	if gl != nil {
		lines = append(lines, *gl)
	}
	if len(lines) == 0 {
		return nil
	}
	at := pickSaleTime(nil, in.ClientCreated)
	if at.IsZero() {
		at = time.Now() // a sale that succeeds today must not fail the ledger's occurred_at check
	}
	_, err = ledger.Record(ctx, tx, ledger.Document{
		Key: "sale:" + orderID, Kind: ledger.KindSale,
		LocationType: ledger.LocOutlet, LocationID: in.OutletID,
		RefType: "order", RefID: orderID, RefNumber: orderNumber,
		Actor: in.CashierID, DeviceID: in.DeviceID,
		OccurredAt: at, Lines: lines,
	})
	if err != nil {
		return fmt.Errorf("record sale movements: %w", err)
	}
	return nil
}

// giveawayLine decrements the outlet's per-sale giveaway item by one (the row is already
// locked: lockStockRowsSorted took the setting FOR SHARE and the stock row FOR UPDATE, and
// recorded the key it locked in the transaction-local setting pos.giveaway, which this reads
// instead of the table: a setting created after the lock phase is not seen, so the decrement
// never touches a stock row outside the sorted lock set)
// and returns its ledger line, or nil when this sale gives nothing away. One unit per
// completed order, whatever the cart holds. The sale is never blocked or failed by the
// giveaway: no setting, a disabled setting or a vanished variant (no stock row) skip it.
// Not restored on refund: the line is not an order item. The marker is the dedupe key
// "giveaway:<order id>"; no flag besides shortage, because flags reach the ERP.
func giveawayLine(ctx context.Context, tx pgx.Tx, orderID, outletID string) (*ledger.Line, error) {
	var locked string
	if err := tx.QueryRow(ctx, `SELECT coalesce(current_setting('pos.giveaway', true), '')`).Scan(&locked); err != nil {
		return nil, err
	}
	pid, size, ok := strings.Cut(locked, "|")
	if !ok {
		return nil, nil // no enabled setting: the normal inert state, no log (a Warn per sale would flood it)
	}
	var after int
	// The variant must still exist: a stock row without one would hold every ERP sale document.
	err := tx.QueryRow(ctx,
		`UPDATE outlet_variant_stock SET stock=stock-1
		  WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3
		    AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=$2 AND pv.size=$3)
		  RETURNING stock`,
		outletID, pid, size).Scan(&after)
	if errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("giveaway skipped: item has no stock row or its variant was removed",
			"outlet", outletID, "product", pid, "size", size, "order", orderID)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l := ledger.Line{
		ProductID: pid, VariantSize: size, Qty: -1,
		QtyBefore: after + 1, QtyAfter: after,
		DedupeKey: "giveaway:" + orderID,
	}
	if after < 0 {
		l.Flags = []string{"shortage"}
	}
	return &l, nil
}
