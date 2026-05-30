package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// IngredientStockCount is the write-model for creating an ingredient stock count.
// Exactly one of LocKind+LocID is used; the kind determines which stock table is
// snapshotted (warehouse → ingredient_warehouse_stock; outlet → ingredient_outlet_stock).
type IngredientStockCount struct {
	Name        string `json:"name"`
	LocKind     string `json:"locKind"`
	LocID       string `json:"locId"`
	PlannedDate string `json:"plannedDate,omitempty"`
	Notes       string `json:"notes,omitempty"`
}

func (r *Repo) CreateIngredientStockCount(ctx context.Context, caller string, in IngredientStockCount) (string, error) {
	if in.Name == "" {
		return "", fmt.Errorf("nama wajib")
	}
	if !validLocKind(in.LocKind) || in.LocID == "" {
		return "", fmt.Errorf("lokasi tidak valid")
	}
	var whID, outID any
	if in.LocKind == "warehouse" {
		whID = in.LocID
	} else {
		outID = in.LocID
	}
	var id string
	if err := r.Pool.QueryRow(ctx,
		`INSERT INTO ingredient_stock_counts (name, status, warehouse_id, outlet_id, planned_date, notes, created_by)
         VALUES ($1, 'planned', $2, $3, NULLIF($4,'')::date, NULLIF($5,''), NULLIF($6,'')::uuid)
         RETURNING id`,
		in.Name, whID, outID, in.PlannedDate, in.Notes, caller,
	).Scan(&id); err != nil {
		return "", fmt.Errorf("insert stock count: %w", err)
	}
	return id, nil
}

// StartIngredientStockCount transitions planned → in_progress and snapshots the
// active ingredient list with current name + unit.
func (r *Repo) StartIngredientStockCount(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var status string
	var whID, outID *string
	if err := tx.QueryRow(ctx,
		`SELECT status, warehouse_id, outlet_id FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
	).Scan(&status, &whID, &outID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load: %w", err)
	}
	if status != "planned" {
		return fmt.Errorf("status %q tidak bisa dimulai", status)
	}
	// Snapshot every active ingredient with its current name + unit.
	if _, err := tx.Exec(ctx,
		`INSERT INTO ingredient_stock_count_items
		     (stock_count_id, ingredient_id, ingredient_name, ingredient_unit)
		 SELECT $1, id, name, unit FROM ingredients WHERE is_active`,
		id,
	); err != nil {
		return fmt.Errorf("snapshot items: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE ingredient_stock_counts SET status='in_progress', started_at=now() WHERE id=$1`,
		id,
	); err != nil {
		return fmt.Errorf("mark started: %w", err)
	}
	return tx.Commit(ctx)
}

type IngredientStockCountSaveItem struct {
	ItemID  string  `json:"itemId"`
	Counted float64 `json:"counted"`
}

func (r *Repo) SaveIngredientStockCount(ctx context.Context, id string, items []IngredientStockCountSaveItem) error {
	if len(items) == 0 {
		return nil
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
	).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load: %w", err)
	}
	if status != "in_progress" {
		return fmt.Errorf("status %q tidak menerima simpan", status)
	}
	for _, it := range items {
		if _, err := tx.Exec(ctx,
			`UPDATE ingredient_stock_count_items SET counted=$2 WHERE id=$1 AND stock_count_id=$3`,
			it.ItemID, it.Counted, id,
		); err != nil {
			return fmt.Errorf("save item: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// CompleteIngredientStockCount writes counted qty into the appropriate stock table
// (ingredient_warehouse_stock or ingredient_outlet_stock), records each line's
// difference (counted − previous qty), and marks the count completed.
// Lines with NULL counted are skipped (operator hasn't touched them).
func (r *Repo) CompleteIngredientStockCount(ctx context.Context, id string) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var status string
	var whID, outID *string
	if err := tx.QueryRow(ctx,
		`SELECT status, warehouse_id, outlet_id FROM ingredient_stock_counts WHERE id=$1 FOR UPDATE`, id,
	).Scan(&status, &whID, &outID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load: %w", err)
	}
	if status != "in_progress" {
		return fmt.Errorf("status %q tidak bisa diselesaikan", status)
	}

	if whID != nil {
		// Warehouse count: apply counted qty to ingredient_warehouse_stock.
		if _, err := tx.Exec(ctx,
			`WITH lines AS (
			    SELECT i.id, i.ingredient_id, i.counted,
			           i.counted - COALESCE(s.qty,0) AS diff
			      FROM ingredient_stock_count_items i
			      LEFT JOIN ingredient_warehouse_stock s
			             ON s.warehouse_id = $2 AND s.ingredient_id = i.ingredient_id
			     WHERE i.stock_count_id = $1 AND i.counted IS NOT NULL
			 ),
			 upd AS (
			     UPDATE ingredient_stock_count_items i
			        SET difference = l.diff
			       FROM lines l WHERE l.id = i.id
			 )
			 INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
			      SELECT $2, ingredient_id, counted FROM lines
			 ON CONFLICT (warehouse_id, ingredient_id)
			 DO UPDATE SET qty = EXCLUDED.qty`,
			id, *whID,
		); err != nil {
			return fmt.Errorf("apply counted (warehouse): %w", err)
		}
	} else {
		// Outlet count: apply counted qty to ingredient_outlet_stock.
		if _, err := tx.Exec(ctx,
			`WITH lines AS (
			    SELECT i.id, i.ingredient_id, i.counted,
			           i.counted - COALESCE(s.qty,0) AS diff
			      FROM ingredient_stock_count_items i
			      LEFT JOIN ingredient_outlet_stock s
			             ON s.outlet_id = $2 AND s.ingredient_id = i.ingredient_id
			     WHERE i.stock_count_id = $1 AND i.counted IS NOT NULL
			 ),
			 upd AS (
			     UPDATE ingredient_stock_count_items i
			        SET difference = l.diff
			       FROM lines l WHERE l.id = i.id
			 )
			 INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
			      SELECT $2, ingredient_id, counted FROM lines
			 ON CONFLICT (outlet_id, ingredient_id)
			 DO UPDATE SET qty = EXCLUDED.qty`,
			id, *outID,
		); err != nil {
			return fmt.Errorf("apply counted (outlet): %w", err)
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE ingredient_stock_counts SET status='completed', completed_at=now() WHERE id=$1`,
		id,
	); err != nil {
		return fmt.Errorf("mark completed: %w", err)
	}
	return tx.Commit(ctx)
}
