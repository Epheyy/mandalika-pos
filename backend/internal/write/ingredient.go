package write

import (
	"context"
	"fmt"
)

// Ingredient is the write-model for the ingredients master table.
type Ingredient struct {
	Name            string   `json:"name"`
	Unit            string   `json:"unit"`
	DefaultUnitCost *float64 `json:"defaultUnitCost,omitempty"`
	Notes           string   `json:"notes,omitempty"`
	IsActive        bool     `json:"isActive"`
}

func validateIngredient(i Ingredient) error {
	if i.Name == "" {
		return fmt.Errorf("nama bahan wajib")
	}
	if i.Unit == "" {
		return fmt.Errorf("satuan bahan wajib")
	}
	return nil
}

// CreateIngredient inserts a new ingredient and returns its generated UUID.
func (r *Repo) CreateIngredient(ctx context.Context, in Ingredient) (string, error) {
	if err := validateIngredient(in); err != nil {
		return "", err
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO ingredients (name, unit, default_unit_cost, notes, is_active)
		 VALUES ($1, $2, $3, NULLIF($4,''), $5)
		 RETURNING id`,
		in.Name, in.Unit, in.DefaultUnitCost, in.Notes, in.IsActive,
	).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create ingredient: %w", err)
	}
	return id, nil
}

// UpdateIngredient replaces all mutable fields of an existing ingredient.
func (r *Repo) UpdateIngredient(ctx context.Context, id string, in Ingredient) error {
	if err := validateIngredient(in); err != nil {
		return err
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE ingredients
		    SET name=$2, unit=$3, default_unit_cost=$4, notes=NULLIF($5,''), is_active=$6
		  WHERE id=$1`,
		id, in.Name, in.Unit, in.DefaultUnitCost, in.Notes, in.IsActive)
	if err != nil {
		return fmt.Errorf("update ingredient: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteIngredient removes an ingredient, blocking if it has an in-transit transfer line.
func (r *Repo) DeleteIngredient(ctx context.Context, id string) error {
	var inTransit int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM ingredient_transfer_items i
		   JOIN ingredient_transfers t ON t.id = i.transfer_id
		  WHERE i.ingredient_id = $1 AND t.status = 'in_transit'`,
		id,
	).Scan(&inTransit); err != nil {
		return fmt.Errorf("check ingredient transfers: %w", err)
	}
	if inTransit > 0 {
		return fmt.Errorf("bahan sedang dalam transfer berjalan (%d)", inTransit)
	}
	tag, err := r.Pool.Exec(ctx, `DELETE FROM ingredients WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete ingredient: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// IngredientGoodsReceiptItem is a single line in a goods receipt.
type IngredientGoodsReceiptItem struct {
	IngredientID string   `json:"ingredientId"`
	Qty          float64  `json:"qty"`
	UnitCost     *float64 `json:"unitCost,omitempty"`
}

// IngredientGoodsReceipt is the write-model for receiving ingredients into a warehouse.
type IngredientGoodsReceipt struct {
	WarehouseID string                       `json:"warehouseId"`
	Supplier    string                       `json:"supplier,omitempty"`
	Note        string                       `json:"note,omitempty"`
	Items       []IngredientGoodsReceiptItem `json:"items"`
}

// CreateIngredientGoodsReceipt records a goods receipt and bumps warehouse stock atomically.
func (r *Repo) CreateIngredientGoodsReceipt(ctx context.Context, caller string, in IngredientGoodsReceipt) (string, error) {
	if in.WarehouseID == "" {
		return "", fmt.Errorf("gudang wajib")
	}
	if len(in.Items) == 0 {
		return "", fmt.Errorf("minimal satu bahan")
	}
	for _, it := range in.Items {
		if it.Qty <= 0 {
			return "", fmt.Errorf("qty harus lebih dari 0")
		}
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var rid string
	if err := tx.QueryRow(ctx,
		`INSERT INTO ingredient_goods_receipts (warehouse_id, supplier, note, created_by)
         VALUES ($1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,'')::uuid)
         RETURNING id`,
		in.WarehouseID, in.Supplier, in.Note, caller,
	).Scan(&rid); err != nil {
		return "", fmt.Errorf("insert receipt: %w", err)
	}
	for _, it := range in.Items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_goods_receipt_items (receipt_id, ingredient_id, qty, unit_cost)
             VALUES ($1, $2, $3, $4)`,
			rid, it.IngredientID, it.Qty, it.UnitCost,
		); err != nil {
			return "", fmt.Errorf("insert receipt item: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, ingredient_id)
             DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
			in.WarehouseID, it.IngredientID, it.Qty,
		); err != nil {
			return "", fmt.Errorf("upsert stock: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return rid, nil
}

// IngredientAdjust is the write-model for a manual stock adjustment.
type IngredientAdjust struct {
	WarehouseID  string  `json:"warehouseId"`
	IngredientID string  `json:"ingredientId"`
	NewQty       float64 `json:"newQty"`
	Reason       string  `json:"reason"`
}

// AdjustIngredientStock sets the absolute stock qty and records the adjustment log atomically.
func (r *Repo) AdjustIngredientStock(ctx context.Context, caller string, in IngredientAdjust) error {
	if in.WarehouseID == "" || in.IngredientID == "" {
		return fmt.Errorf("gudang dan bahan wajib")
	}
	if in.NewQty < 0 {
		return fmt.Errorf("qty tidak boleh negatif")
	}
	if in.Reason == "" {
		return fmt.Errorf("alasan wajib")
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
              VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, ingredient_id)
         DO UPDATE SET qty = EXCLUDED.qty`,
		in.WarehouseID, in.IngredientID, in.NewQty,
	); err != nil {
		return fmt.Errorf("upsert stock: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ingredient_stock_adjustments (warehouse_id, ingredient_id, new_qty, reason, created_by)
         VALUES ($1, $2, $3, $4, NULLIF($5,'')::uuid)`,
		in.WarehouseID, in.IngredientID, in.NewQty, in.Reason, caller,
	); err != nil {
		return fmt.Errorf("insert adjustment: %w", err)
	}
	return tx.Commit(ctx)
}
