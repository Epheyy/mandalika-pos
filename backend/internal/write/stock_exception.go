package write

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Kinds of sale_stock_exceptions rows (A44).
const (
	StockExceptionShortage                = "shortage"
	StockExceptionUnresolvedVariant       = "unresolved_variant"
	StockExceptionRefundUnresolvedVariant = "refund_unresolved_variant"
)

// SaleStockExceptionRow is one oversold / unresolved sale line, recorded in the
// sale transaction. StockBefore/StockAfter are nil for the unresolved kinds.
type SaleStockExceptionRow struct {
	OrderID, OrderItemID, OrderNumber, OutletID string
	ProductID, ProductName, VariantSize         string
	Kind                                        string
	Quantity                                    int
	StockBefore, StockAfter                     *int
	Shortfall                                   int
	Channel                                     string // 'sync' | 'direct'
	CashierID, CashierName                      string
	ShiftID, DeviceID                           string // "" = NULL
	SoldAt                                      time.Time
}

func nullUUIDArg(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// InsertSaleStockException writes one exception row. UNIQUE (order_item_id, kind)
// makes a (never expected) second write for the same line and kind a no-op.
func InsertSaleStockException(ctx context.Context, tx pgx.Tx, r SaleStockExceptionRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO sale_stock_exceptions
		  (order_id, order_item_id, order_number, outlet_id, product_id, product_name,
		   variant_size, kind, quantity, stock_before, stock_after, shortfall, channel,
		   cashier_id, cashier_name, shift_id, device_id, sold_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
		ON CONFLICT (order_item_id, kind) DO NOTHING`,
		r.OrderID, r.OrderItemID, r.OrderNumber, r.OutletID, r.ProductID, r.ProductName,
		r.VariantSize, r.Kind, r.Quantity, r.StockBefore, r.StockAfter, r.Shortfall, r.Channel,
		r.CashierID, r.CashierName, nullUUIDArg(r.ShiftID), nullUUIDArg(r.DeviceID), r.SoldAt)
	if err != nil {
		return fmt.Errorf("insert sale stock exception: %w", err)
	}
	return nil
}
