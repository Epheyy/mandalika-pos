package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type TransferItemInput struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	Qty         int    `json:"qty"`
}

type TransferCreate struct {
	Source TransferLoc         `json:"source"`
	Dest   TransferLoc         `json:"dest"`
	Note   string              `json:"note"`
	Items  []TransferItemInput `json:"items"`
}

type TransferReceiveItem struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ReceivedQty int    `json:"receivedQty"`
}

type TransferReceive struct {
	Items             []TransferReceiveItem `json:"items"`
	DiscrepancyReason string                `json:"discrepancyReason"`
}

// loaded transfer row (locations are nil for the leg that is the other kind).
type transferRow struct {
	status                                           string
	srcOutlet, srcWarehouse, dstOutlet, dstWarehouse *string
}

type transferLine struct {
	pid, size string
	sent      int
}

func validateLocs(src, dst TransferLoc) error {
	if !validLocKind(src.Kind) || src.ID == "" {
		return fmt.Errorf("sumber tidak valid")
	}
	if !validLocKind(dst.Kind) || dst.ID == "" {
		return fmt.Errorf("tujuan tidak valid")
	}
	if sameLoc(src, dst) {
		return fmt.Errorf("sumber dan tujuan tidak boleh sama")
	}
	return nil
}

// locCols returns ("", id) for a warehouse and (id, "") for an outlet, ready for
// nullUUID() into the (outlet_id, warehouse_id) column pair.
func locCols(loc TransferLoc) (outletID, warehouseID string) {
	if loc.Kind == "outlet" {
		return loc.ID, ""
	}
	return "", loc.ID
}

func validateItems(items []TransferItemInput) error {
	if len(items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

func insertTransferItems(ctx context.Context, tx pgx.Tx, id string, items []TransferItemInput) error {
	for _, it := range items {
		if _, e := tx.Exec(ctx,
			`INSERT INTO transfer_items (transfer_id, product_id, variant_size, sent_qty)
			 VALUES ($1,$2,$3,$4)`, id, it.ProductID, it.VariantSize, it.Qty); e != nil {
			return e
		}
	}
	return nil
}

func loadTransfer(ctx context.Context, q pgx.Tx, id string) (transferRow, error) {
	var t transferRow
	e := q.QueryRow(ctx,
		`SELECT status, source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id
		   FROM transfers WHERE id=$1`, id).Scan(
		&t.status, &t.srcOutlet, &t.srcWarehouse, &t.dstOutlet, &t.dstWarehouse)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, e
}

func transferLines(ctx context.Context, q pgx.Tx, id string) ([]transferLine, error) {
	rows, e := q.Query(ctx,
		`SELECT product_id, variant_size, sent_qty FROM transfer_items WHERE transfer_id=$1`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var out []transferLine
	for rows.Next() {
		var l transferLine
		if e := rows.Scan(&l.pid, &l.size, &l.sent); e != nil {
			return nil, e
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// addStockDelta applies a signed delta to the right stock table for one leg.
// Exactly one of outletID/warehouseID is non-nil. The column list mirrors
// stockcount.go so par_level/available keep their defaults.
func addStockDelta(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string, delta int) error {
	if outletID != nil {
		_, e := q.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			*outletID, productID, size, delta)
		return e
	}
	_, e := q.Exec(ctx,
		`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (warehouse_id, product_id, variant_size)
		   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
		*warehouseID, productID, size, delta)
	return e
}

// currentStock reads on-hand for one leg (0 when no row yet).
func currentStock(ctx context.Context, q pgx.Tx, outletID, warehouseID *string, productID, size string) (int, error) {
	var n int
	var e error
	if outletID != nil {
		e = q.QueryRow(ctx,
			`SELECT COALESCE(stock,0) FROM outlet_variant_stock
			  WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`,
			*outletID, productID, size).Scan(&n)
	} else {
		e = q.QueryRow(ctx,
			`SELECT COALESCE(stock,0) FROM warehouse_variant_stock
			  WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`,
			*warehouseID, productID, size).Scan(&n)
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, e
}

// CreateTransfer records a draft (no stock movement, no version bump).
func (r *Repo) CreateTransfer(ctx context.Context, createdBy string, t TransferCreate) (string, error) {
	if e := validateLocs(t.Source, t.Dest); e != nil {
		return "", e
	}
	if e := validateItems(t.Items); e != nil {
		return "", e
	}
	so, sw := locCols(t.Source)
	do, dw := locCols(t.Dest)
	var id string
	err := r.noBumpTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO transfers (status, source_outlet_id, source_warehouse_id,
			   dest_outlet_id, dest_warehouse_id, note, created_by)
			 VALUES ('draft',$1,$2,$3,$4,$5,$6) RETURNING id`,
			nullUUID(so), nullUUID(sw), nullUUID(do), nullUUID(dw),
			nullStr(t.Note), nullUUID(createdBy)).Scan(&id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	})
	return id, err
}

// UpdateTransferDraft replaces a draft's note + items. Source/dest are fixed at
// create and ignored here. Only drafts are editable.
func (r *Repo) UpdateTransferDraft(ctx context.Context, id string, t TransferCreate) error {
	if e := validateItems(t.Items); e != nil {
		return e
	}
	return r.noBumpTx(ctx, func(tx pgx.Tx) error {
		var status string
		e := tx.QueryRow(ctx, `SELECT status FROM transfers WHERE id=$1`, id).Scan(&status)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if status != "draft" {
			return fmt.Errorf("hanya draft yang bisa diubah")
		}
		if _, e := tx.Exec(ctx, `UPDATE transfers SET note=$1 WHERE id=$2`, nullStr(t.Note), id); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `DELETE FROM transfer_items WHERE transfer_id=$1`, id); e != nil {
			return e
		}
		return insertTransferItems(ctx, tx, id, t.Items)
	})
}
