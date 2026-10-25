package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// D13 guard: a variant rename, a variant delete, a product delete and a warehouse delete
// must never move or destroy stock. Each one first locks every stock row it will touch
// and refuses (409) while any of them is non-zero; the statement that then deletes or
// moves the rows is itself checked through RETURNING (guardedZeroWrite), because a sale
// can lazily create and decrement a row after the pre-lock. Negative stock blocks too.

// ErrVariantHasStock matches (errors.Is) every refusal of this guard.
var ErrVariantHasStock = apperr.New(apperr.Conflict, "varian masih punya stok")

// ErrSizeResidue is the refusal of a rename onto a size that still has stock or price rows
// (the same rule as the CSV planner's size_stock_residue).
var ErrSizeResidue = apperr.New(apperr.Conflict,
	"ukuran tujuan masih punya sisa baris stok atau harga (di outlet atau gudang) dari varian lama; kosongkan lewat penyesuaian stok atau pilih ukuran lain")

// ErrProductHasHistory refuses a product delete once a goods receipt, stock adjustment or
// transfer line names the product. Those documents keep a plain foreign key to products
// (0015 goods_receipt_items and warehouse_stock_adjustments, 0016 transfer_items), and
// deleting them would erase stock history; deactivating the product hides it instead.
var ErrProductHasHistory = apperr.New(apperr.Conflict,
	"produk punya riwayat stok (penerimaan, penyesuaian atau transfer) sehingga tidak bisa dihapus; nonaktifkan produk saja (matikan Produk Aktif)")

// IsProductHasHistory reports whether err is the ErrProductHasHistory refusal.
func IsProductHasHistory(err error) bool { return errors.Is(err, ErrProductHasHistory) }

// guardProductHistory refuses the delete while a receipt, adjustment or transfer line names
// the product. It runs under lockProductRow: inserting such a line takes a KEY SHARE lock
// on the product row, so none can commit between this check and the delete.
func guardProductHistory(ctx context.Context, tx pgx.Tx, id string) error {
	var has bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM goods_receipt_items WHERE product_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM warehouse_stock_adjustments WHERE product_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM transfer_items WHERE product_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM stock_requisition_items WHERE product_id = $1::uuid)`, id).Scan(&has); err != nil {
		return err
	}
	if has {
		return ErrProductHasHistory
	}
	return nil
}

// ErrWarehouseHasHistory refuses a warehouse delete once a stock document names the
// warehouse. Transfers (0016, product and 0019 ingredient) keep a plain foreign key to
// warehouses; receipts, adjustments and stock counts (0015 and 0019, product and
// ingredient) cascade from it, so the delete would silently erase them. Deactivating
// the warehouse hides it instead.
var ErrWarehouseHasHistory = apperr.New(apperr.Conflict,
	"gudang punya riwayat stok (penerimaan, penyesuaian, opname atau transfer) sehingga tidak bisa dihapus; nonaktifkan gudang saja (matikan Gudang Aktif)")

// IsWarehouseHasHistory reports whether err is the ErrWarehouseHasHistory refusal.
func IsWarehouseHasHistory(err error) bool { return errors.Is(err, ErrWarehouseHasHistory) }

// guardWarehouseHistory refuses the delete while any stock document names the warehouse.
// It runs under lockWarehouseRow: every table listed holds a foreign key to warehouses, so
// an insert takes a KEY SHARE lock on the warehouse row and none can commit between this
// check and the delete. stock_movements is left out on purpose: it has no foreign key so
// that history survives deletes.
func guardWarehouseHistory(ctx context.Context, tx pgx.Tx, id string) error {
	var has bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM goods_receipts WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM warehouse_stock_adjustments WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM stock_counts WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM transfers WHERE source_warehouse_id = $1::uuid OR dest_warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM stock_requisitions WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM ingredient_goods_receipts WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM ingredient_stock_adjustments WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM ingredient_stock_counts WHERE warehouse_id = $1::uuid)
		    OR EXISTS (SELECT 1 FROM ingredient_transfers WHERE source_warehouse_id = $1::uuid OR dest_warehouse_id = $1::uuid)`,
		id).Scan(&has); err != nil {
		return err
	}
	if has {
		return ErrWarehouseHasHistory
	}
	return nil
}

// IsStockGuardRefusal reports whether err is a D13 refusal that handlers answer with 409.
func IsStockGuardRefusal(err error) bool {
	return errors.Is(err, ErrVariantHasStock) || errors.Is(err, ErrSizeResidue)
}

// VariantHasStockError names the first location (and size) that still holds stock.
type VariantHasStockError struct{ Where string }

func (e *VariantHasStockError) Error() string {
	return "varian masih punya stok di " + e.Where + "; nolkan lewat penyesuaian dulu"
}

func (e *VariantHasStockError) ErrorCode() apperr.Code { return apperr.Conflict }

func (e *VariantHasStockError) Is(target error) bool { return target == ErrVariantHasStock }

// ProductHasStockError is the product-delete form of VariantHasStockError. It points to
// deactivating rather than zeroing: the adjustment that zeroes the stock is itself history,
// so the delete would then be refused by ErrProductHasHistory. Still a D13 refusal (409).
type ProductHasStockError struct{ Where string }

func (e *ProductHasStockError) Error() string {
	return "produk masih punya stok di " + e.Where + " sehingga tidak bisa dihapus; nonaktifkan produk saja (matikan Produk Aktif)"
}

func (e *ProductHasStockError) ErrorCode() apperr.Code { return apperr.Conflict }

func (e *ProductHasStockError) Is(target error) bool { return target == ErrVariantHasStock }

// productStockRefusal turns a stock refusal of DeleteProduct into ProductHasStockError;
// any other error passes through unchanged.
func productStockRefusal(err error) error {
	var v *VariantHasStockError
	if errors.As(err, &v) {
		return &ProductHasStockError{Where: v.Where}
	}
	return err
}

// WarehouseHasStockError is the warehouse-delete form of VariantHasStockError, for the same
// reason as ProductHasStockError: zeroing by adjustment writes a document, and the delete is
// then refused by ErrWarehouseHasHistory. Still a D13 refusal (409).
type WarehouseHasStockError struct{ Where string }

func (e *WarehouseHasStockError) Error() string {
	return "gudang masih punya stok di " + e.Where + " sehingga tidak bisa dihapus; nonaktifkan gudang saja (matikan Gudang Aktif)"
}

func (e *WarehouseHasStockError) ErrorCode() apperr.Code { return apperr.Conflict }

func (e *WarehouseHasStockError) Is(target error) bool { return target == ErrVariantHasStock }

// warehouseStockRefusal turns a stock refusal of DeleteWarehouse into WarehouseHasStockError;
// any other error passes through unchanged.
func warehouseStockRefusal(err error) error {
	var v *VariantHasStockError
	if errors.As(err, &v) {
		return &WarehouseHasStockError{Where: v.Where}
	}
	return err
}

func hasStockAt(location, size string) error {
	return &VariantHasStockError{Where: fmt.Sprintf("%s (ukuran %s)", location, size)}
}

// Lock order: outlet rows first, then warehouse rows; inside each table by (location,
// product, size). That is the order SetProductOutletConfig and the CSV rename already
// take outlet rows in, and for any single location it equals the (product_id,
// variant_size) order sales, refunds and receipts lock in (A42), so the guard cannot
// close a cycle with them. The ORDER BY sits before FOR UPDATE: PostgreSQL sorts first,
// then locks. Only the fixed fragments below are concatenated; values are parameters.
const (
	lockOutletRows = `
		SELECT 'outlet', o.name, s.variant_size, s.stock
		  FROM outlet_variant_stock s JOIN outlets o ON o.id = s.outlet_id
		 WHERE %s
		 ORDER BY s.outlet_id, s.product_id, s.variant_size
		   FOR UPDATE OF s`
	lockWarehouseRows = `
		SELECT 'gudang', w.name, s.variant_size, s.stock
		  FROM warehouse_variant_stock s JOIN warehouses w ON w.id = s.warehouse_id
		 WHERE %s
		 ORDER BY s.warehouse_id, s.product_id, s.variant_size
		   FOR UPDATE OF s`
	whereKeys      = `(s.product_id, s.variant_size) IN (SELECT k.pid, k.size FROM unnest($1::uuid[], $2::text[]) AS k(pid, size))`
	whereProduct   = `s.product_id = $1::uuid`
	whereWarehouse = `s.warehouse_id = $1::uuid`
)

// lockStockRows locks the rows a query selects and returns the refusal for the first
// non-zero one (after locking all of them, so the caller's tx holds the full set).
func lockStockRows(ctx context.Context, tx pgx.Tx, sql string, args ...any) error {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	var first error
	for rows.Next() {
		var kind, name, size string
		var stock int
		if err := rows.Scan(&kind, &name, &size, &stock); err != nil {
			return err
		}
		if stock != 0 && first == nil {
			first = hasStockAt(kind+" "+name, size)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return first
}

// lockStockKeys locks the outlet and warehouse stock rows of the (product, size) pairs.
func lockStockKeys(ctx context.Context, tx pgx.Tx, pids, sizes []string) error {
	if len(pids) == 0 {
		return nil
	}
	if err := lockStockRows(ctx, tx, fmt.Sprintf(lockOutletRows, whereKeys), pids, sizes); err != nil {
		return err
	}
	return lockStockRows(ctx, tx, fmt.Sprintf(lockWarehouseRows, whereKeys), pids, sizes)
}

// lockVariantStock locks every outlet and warehouse stock row of one product's sizes and
// refuses while any is non-zero.
func lockVariantStock(ctx context.Context, tx pgx.Tx, productID string, sizes []string) error {
	pids := make([]string, len(sizes))
	for i := range pids {
		pids[i] = productID
	}
	return lockStockKeys(ctx, tx, pids, sizes)
}

// lockProductStock is the product-wide form (DeleteProduct): every size, every location.
func lockProductStock(ctx context.Context, tx pgx.Tx, productID string) error {
	if err := lockStockRows(ctx, tx, fmt.Sprintf(lockOutletRows, whereProduct), productID); err != nil {
		return err
	}
	return lockStockRows(ctx, tx, fmt.Sprintf(lockWarehouseRows, whereProduct), productID)
}

// lockWarehouseStock is the warehouse-wide form (DeleteWarehouse).
func lockWarehouseStock(ctx context.Context, tx pgx.Tx, warehouseID string) error {
	return lockStockRows(ctx, tx, fmt.Sprintf(lockWarehouseRows, whereWarehouse), warehouseID)
}

// guardedZeroWrite runs a DELETE or UPDATE of stock rows that must only ever touch
// zero-stock rows. The statement must end in `RETURNING <location id>::text,
// variant_size, stock`; a non-zero row means a writer got in after the pre-lock, so the
// refusal is returned and the caller's transaction rolls back (nothing is lost). kind is
// "outlet" or "warehouse" and only selects the table the location name is read from.
func guardedZeroWrite(ctx context.Context, tx pgx.Tx, kind, sql string, args ...any) error {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	var badLoc, badSize string
	found := false
	for rows.Next() {
		var loc, size string
		var stock int
		if err := rows.Scan(&loc, &size, &stock); err != nil {
			return err
		}
		if stock != 0 && !found {
			found, badLoc, badSize = true, loc, size
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if !found {
		return nil
	}
	rows.Close()
	return hasStockAt(locationLabel(ctx, tx, kind, badLoc), badSize)
}

// locationLabel resolves "outlet <name>" / "gudang <name>" for an error message; a
// failed lookup falls back to the id (the refusal still stands).
func locationLabel(ctx context.Context, tx pgx.Tx, kind, id string) (label string) {
	sql, prefix := `SELECT name FROM outlets WHERE id = $1::uuid`, "outlet"
	if kind == "warehouse" {
		sql, prefix = `SELECT name FROM warehouses WHERE id = $1::uuid`, "gudang"
	}
	var name string
	if err := tx.QueryRow(ctx, sql, id).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		name = id
	}
	if name == "" {
		name = id
	}
	return prefix + " " + name
}

// lockProductRow and lockWarehouseRow take the parent row FOR UPDATE as the FIRST statement of
// a delete. A concurrent goods receipt or sale inserting a stock row holds KEY SHARE on the
// parent through its foreign key: FOR UPDATE waits for it to finish, so the row it created is
// committed and visible to the pre-lock and the RETURNING check that follow; a later insert
// blocks on the lock and then fails the foreign key. Without it, such a row could commit
// while the parent DELETE waits and be removed by the FK cascade.
func lockProductRow(ctx context.Context, tx pgx.Tx, id string) error {
	return lockParent(ctx, tx, `SELECT 1 FROM products WHERE id = $1::uuid FOR UPDATE`, id)
}

func lockWarehouseRow(ctx context.Context, tx pgx.Tx, id string) error {
	return lockParent(ctx, tx, `SELECT 1 FROM warehouses WHERE id = $1::uuid FOR UPDATE`, id)
}

func lockParent(ctx context.Context, tx pgx.Tx, sql, id string) error {
	var one int
	if err := tx.QueryRow(ctx, sql, id).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	return nil
}

// ensureSizeFree refuses a rename onto a size that already has stock or price rows.
func ensureSizeFree(ctx context.Context, tx pgx.Tx, productID, size string) error {
	var used bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM outlet_variant_stock WHERE product_id = $1 AND variant_size = $2)
		    OR EXISTS (SELECT 1 FROM outlet_variant_price WHERE product_id = $1 AND variant_size = $2)
		    OR EXISTS (SELECT 1 FROM warehouse_variant_stock WHERE product_id = $1 AND variant_size = $2)`,
		productID, size).Scan(&used); err != nil {
		return err
	}
	if used {
		return ErrSizeResidue
	}
	return nil
}
