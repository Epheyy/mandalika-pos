package write

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type IngredientTransferItemInput struct {
	IngredientID string  `json:"ingredientId"`
	Qty          float64 `json:"qty"`
}

// IngredientTransferCreate uses polymorphic TransferLoc for source and dest,
// matching the product transfer mesh pattern.
type IngredientTransferCreate struct {
	Source TransferLoc                   `json:"source"`
	Dest   TransferLoc                   `json:"dest"`
	Note   string                        `json:"note"`
	Items  []IngredientTransferItemInput `json:"items"`
}

type IngredientTransferReceiveItem struct {
	ItemID      string  `json:"itemId"`
	ReceivedQty float64 `json:"receivedQty"`
}
type IngredientTransferReceive struct {
	Items             []IngredientTransferReceiveItem `json:"items"`
	DiscrepancyReason string                          `json:"discrepancyReason"`
}

// ingTransferRow holds the status and the four nullable location columns loaded
// from ingredient_transfers. Exactly one of (srcOutlet, srcWarehouse) and exactly
// one of (dstOutlet, dstWarehouse) will be non-nil after the migration.
type ingTransferRow struct {
	status                                           string
	srcOutlet, srcWarehouse, dstOutlet, dstWarehouse *string
}

type ingTransferLine struct {
	ingID string
	qty   float64
}

func validateIngTransfer(c IngredientTransferCreate) error {
	if !validLocKind(c.Source.Kind) || c.Source.ID == "" {
		return fmt.Errorf("lokasi sumber tidak valid")
	}
	if !validLocKind(c.Dest.Kind) || c.Dest.ID == "" {
		return fmt.Errorf("lokasi tujuan tidak valid")
	}
	if sameLoc(c.Source, c.Dest) {
		return fmt.Errorf("tidak boleh transfer ke lokasi yang sama")
	}
	if len(c.Items) == 0 {
		return fmt.Errorf("minimal satu bahan")
	}
	for _, it := range c.Items {
		if it.IngredientID == "" || it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return nil
}

func loadIngTransfer(ctx context.Context, tx pgx.Tx, id string) (ingTransferRow, error) {
	var t ingTransferRow
	e := tx.QueryRow(ctx,
		`SELECT status, source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id
		   FROM ingredient_transfers WHERE id=$1 FOR UPDATE`, id).Scan(
		&t.status, &t.srcOutlet, &t.srcWarehouse, &t.dstOutlet, &t.dstWarehouse)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, e
}

func loadIngTransferLines(ctx context.Context, tx pgx.Tx, id string) ([]ingTransferLine, error) {
	rows, e := tx.Query(ctx,
		`SELECT ingredient_id, sent_qty FROM ingredient_transfer_items WHERE transfer_id=$1`, id)
	if e != nil {
		return nil, fmt.Errorf("load items: %w", e)
	}
	defer rows.Close()
	var out []ingTransferLine
	for rows.Next() {
		var l ingTransferLine
		if e := rows.Scan(&l.ingID, &l.qty); e != nil {
			return nil, fmt.Errorf("scan item: %w", e)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// addIngStockDelta applies a signed delta to the right ingredient stock table.
// Exactly one of outletID/warehouseID must be non-nil (DB CHECKs guarantee this
// on persisted rows; the explicit nil guard converts a corrupt-row case from a
// panic into a recoverable error).
func addIngStockDelta(ctx context.Context, tx pgx.Tx, outletID, warehouseID *string, ingID string, delta float64) error {
	if outletID != nil {
		_, e := tx.Exec(ctx,
			`INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (outlet_id, ingredient_id)
			   DO UPDATE SET qty = ingredient_outlet_stock.qty + EXCLUDED.qty`,
			*outletID, ingID, delta)
		return e
	}
	if warehouseID == nil {
		return fmt.Errorf("addIngStockDelta: both location pointers nil for ingredient %s", ingID)
	}
	_, e := tx.Exec(ctx,
		`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
		 VALUES ($1,$2,$3)
		 ON CONFLICT (warehouse_id, ingredient_id)
		   DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
		*warehouseID, ingID, delta)
	return e
}

// currentIngStock reads on-hand qty for one leg (0 when no row yet).
func currentIngStock(ctx context.Context, tx pgx.Tx, outletID, warehouseID *string, ingID string) (float64, error) {
	var n float64
	var e error
	if outletID != nil {
		e = tx.QueryRow(ctx,
			`SELECT COALESCE(qty,0) FROM ingredient_outlet_stock
			  WHERE outlet_id=$1 AND ingredient_id=$2 FOR UPDATE`,
			*outletID, ingID).Scan(&n)
	} else {
		e = tx.QueryRow(ctx,
			`SELECT COALESCE(qty,0) FROM ingredient_warehouse_stock
			  WHERE warehouse_id=$1 AND ingredient_id=$2 FOR UPDATE`,
			*warehouseID, ingID).Scan(&n)
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, e
}

func (r *Repo) CreateIngredientTransfer(ctx context.Context, caller string, in IngredientTransferCreate) (string, error) {
	if err := validateIngTransfer(in); err != nil {
		return "", err
	}
	so, sw := locCols(in.Source)
	do, dw := locCols(in.Dest)
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx,
		`INSERT INTO ingredient_transfers
		     (source_outlet_id, source_warehouse_id, dest_outlet_id, dest_warehouse_id, note, created_by)
		 VALUES ($1, $2, $3, $4, NULLIF($5,''), NULLIF($6,'')::uuid)
		 RETURNING id`,
		nullUUID(so), nullUUID(sw), nullUUID(do), nullUUID(dw), in.Note, caller,
	).Scan(&id); err != nil {
		return "", fmt.Errorf("insert transfer: %w", err)
	}
	for _, it := range in.Items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_transfer_items (transfer_id, ingredient_id, sent_qty)
             VALUES ($1, $2, $3)`,
			id, it.IngredientID, it.Qty,
		); err != nil {
			return "", fmt.Errorf("insert transfer item: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return id, nil
}

func (r *Repo) SendIngredientTransfer(ctx context.Context, caller, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	t, e := loadIngTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	if t.status != "draft" {
		return fmt.Errorf("transfer tidak dalam status draft")
	}

	lines, e := loadIngTransferLines(ctx, tx, id)
	if e != nil {
		return e
	}

	// Validate source stock >= each sent_qty; deduct in tx.
	for _, l := range lines {
		have, e := currentIngStock(ctx, tx, t.srcOutlet, t.srcWarehouse, l.ingID)
		if e != nil {
			return fmt.Errorf("lock stock: %w", e)
		}
		if have < l.qty {
			return fmt.Errorf("stok kurang untuk bahan %s (tersedia %.3f, butuh %.3f)", l.ingID, have, l.qty)
		}
		if e := addIngStockDelta(ctx, tx, t.srcOutlet, t.srcWarehouse, l.ingID, -l.qty); e != nil {
			return fmt.Errorf("deduct stock: %w", e)
		}
	}

	// Stamp surat jalan (per-year ISJ counter) + mark in_transit.
	sj, e := nextDocNo(ctx, tx, "ISJ", time.Now().Year())
	if e != nil {
		return e
	}
	if _, err := tx.Exec(ctx,
		`UPDATE ingredient_transfers
		    SET status='in_transit', sent_at=now(), sent_by=NULLIF($2,'')::uuid, surat_jalan_no=$3
		  WHERE id=$1`,
		id, caller, sj,
	); err != nil {
		return fmt.Errorf("stamp send: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repo) ReceiveIngredientTransfer(ctx context.Context, caller, id string, in IngredientTransferReceive) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	t, e := loadIngTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	// Idempotent replay: already completed → succeed as a no-op.
	if t.status == "completed" {
		return tx.Commit(ctx)
	}
	if t.status != "in_transit" {
		return fmt.Errorf("transfer tidak dalam status in_transit")
	}

	hasDiff := false
	for _, it := range in.Items {
		if it.ReceivedQty < 0 {
			return fmt.Errorf("qty tidak boleh negatif")
		}
		var ingID string
		var sent float64
		if err := tx.QueryRow(ctx,
			`SELECT ingredient_id, sent_qty FROM ingredient_transfer_items
			  WHERE id=$1 AND transfer_id=$2 FOR UPDATE`,
			it.ItemID, id,
		).Scan(&ingID, &sent); err != nil {
			return fmt.Errorf("load item %s: %w", it.ItemID, err)
		}
		diff := it.ReceivedQty - sent
		if diff != 0 {
			hasDiff = true
		}
		if _, err := tx.Exec(ctx,
			`UPDATE ingredient_transfer_items
			    SET received_qty=$2, difference=$3 WHERE id=$1`,
			it.ItemID, it.ReceivedQty, diff,
		); err != nil {
			return fmt.Errorf("update item: %w", err)
		}
		if e := addIngStockDelta(ctx, tx, t.dstOutlet, t.dstWarehouse, ingID, it.ReceivedQty); e != nil {
			return fmt.Errorf("credit dest: %w", e)
		}
	}
	if hasDiff && in.DiscrepancyReason == "" {
		return fmt.Errorf("alasan selisih wajib")
	}

	tt, e := nextDocNo(ctx, tx, "ITT", time.Now().Year())
	if e != nil {
		return e
	}
	if _, err := tx.Exec(ctx,
		`UPDATE ingredient_transfers
		    SET status='completed', received_at=now(),
		        received_by=NULLIF($2,'')::uuid,
		        tanda_terima_no=$3,
		        discrepancy_reason=NULLIF($4,'')
		  WHERE id=$1`,
		id, caller, tt, in.DiscrepancyReason,
	); err != nil {
		return fmt.Errorf("stamp receive: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repo) CancelIngredientTransfer(ctx context.Context, caller, id, reason string) error {
	if reason == "" {
		return fmt.Errorf("alasan wajib")
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	t, e := loadIngTransfer(ctx, tx, id)
	if e != nil {
		return e
	}
	switch t.status {
	case "draft":
		// pure void — no stock effect
	case "in_transit":
		// restore each line's sent qty to the source's correct table.
		lines, e := loadIngTransferLines(ctx, tx, id)
		if e != nil {
			return e
		}
		for _, l := range lines {
			if e := addIngStockDelta(ctx, tx, t.srcOutlet, t.srcWarehouse, l.ingID, l.qty); e != nil {
				return fmt.Errorf("restore stock: %w", e)
			}
		}
	default:
		return fmt.Errorf("status %q tidak bisa dibatalkan", t.status)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE ingredient_transfers
		    SET status='cancelled', cancelled_at=now(), cancel_reason=$2
		  WHERE id=$1`,
		id, reason,
	); err != nil {
		return fmt.Errorf("mark cancelled: %w", err)
	}
	return tx.Commit(ctx)
}
