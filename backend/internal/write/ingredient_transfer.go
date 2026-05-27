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
type IngredientTransferCreate struct {
	SourceWarehouseID string                        `json:"sourceWarehouseId"`
	DestWarehouseID   string                        `json:"destWarehouseId"`
	Note              string                        `json:"note"`
	Items             []IngredientTransferItemInput `json:"items"`
}

type IngredientTransferReceiveItem struct {
	ItemID      string  `json:"itemId"`
	ReceivedQty float64 `json:"receivedQty"`
}
type IngredientTransferReceive struct {
	Items             []IngredientTransferReceiveItem `json:"items"`
	DiscrepancyReason string                          `json:"discrepancyReason"`
}

func validateIngTransfer(c IngredientTransferCreate) error {
	if c.SourceWarehouseID == "" || c.DestWarehouseID == "" {
		return fmt.Errorf("gudang sumber dan tujuan wajib")
	}
	if c.SourceWarehouseID == c.DestWarehouseID {
		return fmt.Errorf("sumber dan tujuan tidak boleh sama")
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

func (r *Repo) CreateIngredientTransfer(ctx context.Context, caller string, in IngredientTransferCreate) (string, error) {
	if err := validateIngTransfer(in); err != nil {
		return "", err
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx,
		`INSERT INTO ingredient_transfers
             (source_warehouse_id, dest_warehouse_id, note, created_by)
         VALUES ($1, $2, NULLIF($3,''), NULLIF($4,'')::uuid)
         RETURNING id`,
		in.SourceWarehouseID, in.DestWarehouseID, in.Note, caller,
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

	var status, src string
	if err := tx.QueryRow(ctx,
		`SELECT status, source_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
		id,
	).Scan(&status, &src); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load transfer: %w", err)
	}
	if status != "draft" {
		return fmt.Errorf("transfer tidak dalam status draft")
	}

	// Validate source on-hand >= each sent_qty; deduct in tx.
	rows, err := tx.Query(ctx,
		`SELECT ingredient_id, sent_qty FROM ingredient_transfer_items WHERE transfer_id=$1`, id,
	)
	if err != nil {
		return fmt.Errorf("load items: %w", err)
	}
	type line struct {
		ingID string
		qty   float64
	}
	var items []line
	for rows.Next() {
		var l line
		if err := rows.Scan(&l.ingID, &l.qty); err != nil {
			rows.Close()
			return fmt.Errorf("scan item: %w", err)
		}
		items = append(items, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate items: %w", err)
	}

	for _, l := range items {
		var have float64
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(qty,0) FROM ingredient_warehouse_stock
              WHERE warehouse_id=$1 AND ingredient_id=$2 FOR UPDATE`,
			src, l.ingID,
		).Scan(&have)
		if errors.Is(err, pgx.ErrNoRows) {
			have = 0
		} else if err != nil {
			return fmt.Errorf("lock stock: %w", err)
		}
		if have < l.qty {
			return fmt.Errorf("stok kurang untuk bahan %s (tersedia %.3f, butuh %.3f)", l.ingID, have, l.qty)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE ingredient_warehouse_stock SET qty = qty - $3
              WHERE warehouse_id=$1 AND ingredient_id=$2`,
			src, l.ingID, l.qty,
		); err != nil {
			return fmt.Errorf("deduct stock: %w", err)
		}
	}

	// Stamp surat jalan (per-year ISJ counter) + mark in_transit.
	sj, err := nextDocNo(ctx, tx, "ISJ", time.Now().Year())
	if err != nil {
		return err
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

	var status, dst string
	if err := tx.QueryRow(ctx,
		`SELECT status, dest_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
		id,
	).Scan(&status, &dst); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load transfer: %w", err)
	}
	if status == "completed" {
		// Idempotent replay: already done; treat as success.
		return tx.Commit(ctx)
	}
	if status != "in_transit" {
		return fmt.Errorf("transfer tidak dalam status in_transit")
	}

	// Per-item: compute difference, credit dest with actual received_qty.
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
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, ingredient_id)
             DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
			dst, ingID, it.ReceivedQty,
		); err != nil {
			return fmt.Errorf("credit dest: %w", err)
		}
	}
	if hasDiff && in.DiscrepancyReason == "" {
		return fmt.Errorf("alasan selisih wajib")
	}

	tt, err := nextDocNo(ctx, tx, "ITT", time.Now().Year())
	if err != nil {
		return err
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

	var status, src string
	if err := tx.QueryRow(ctx,
		`SELECT status, source_warehouse_id FROM ingredient_transfers WHERE id=$1 FOR UPDATE`,
		id,
	).Scan(&status, &src); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load transfer: %w", err)
	}
	switch status {
	case "draft":
		// pure void
	case "in_transit":
		// restore source stock — collect all lines first (pgx forbids exec on a
		// tx with open rows), then iterate.
		rows, err := tx.Query(ctx,
			`SELECT ingredient_id, sent_qty FROM ingredient_transfer_items WHERE transfer_id=$1`, id,
		)
		if err != nil {
			return fmt.Errorf("load items: %w", err)
		}
		type line struct {
			ing string
			qty float64
		}
		var lines []line
		for rows.Next() {
			var l line
			if err := rows.Scan(&l.ing, &l.qty); err != nil {
				rows.Close()
				return fmt.Errorf("scan item: %w", err)
			}
			lines = append(lines, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate items: %w", err)
		}
		for _, l := range lines {
			if _, err := tx.Exec(ctx,
				`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                      VALUES ($1, $2, $3)
                 ON CONFLICT (warehouse_id, ingredient_id)
                 DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
				src, l.ing, l.qty,
			); err != nil {
				return fmt.Errorf("restore stock: %w", err)
			}
		}
	default:
		return fmt.Errorf("status %q tidak bisa dibatalkan", status)
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
