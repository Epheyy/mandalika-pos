package write

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5/pgconn"
)

// Ingredient is the write-model for the ingredients master table.
type Ingredient struct {
	Name            string   `json:"name"`
	Unit            string   `json:"unit"`
	SKU             string   `json:"sku"`
	CategoryID      *string  `json:"categoryId,omitempty"`
	DefaultUnitCost *float64 `json:"defaultUnitCost,omitempty"`
	Notes           string   `json:"notes,omitempty"`
	IsActive        bool     `json:"isActive"`
}

// ptrStr returns the string value or "" for a nil pointer (for NULLIF columns).
func ptrStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// skuConflictErr converts a pg unique_violation on idx_ingredient_sku to a
// user-readable error; passes other errors through.
func skuConflictErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "idx_ingredient_sku" {
		return fmt.Errorf("SKU bahan sudah dipakai")
	}
	return err
}

func validateIngredient(i Ingredient) error {
	if i.Name == "" {
		return fmt.Errorf("nama bahan wajib")
	}
	if i.Unit == "" {
		return fmt.Errorf("satuan bahan wajib")
	}
	return validateDefaultUnitCost(i.DefaultUnitCost)
}

// validateDefaultUnitCost rejects a negative, non-finite or oversized default cost (0 and nil are fine).
func validateDefaultUnitCost(c *float64) error {
	if c == nil {
		return nil
	}
	if math.IsNaN(*c) || math.IsInf(*c, 0) || *c < 0 {
		return fmt.Errorf("biaya default tidak boleh negatif")
	}
	if *c > MaxUnitCost {
		return fmt.Errorf("biaya default terlalu besar")
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
		`INSERT INTO ingredients (name, unit, sku, category_id, default_unit_cost, notes, is_active)
		 VALUES ($1, $2, $3, NULLIF($4,'')::uuid, $5, NULLIF($6,''), $7)
		 RETURNING id`,
		in.Name, in.Unit, in.SKU, ptrStr(in.CategoryID), in.DefaultUnitCost, in.Notes, in.IsActive,
	).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create ingredient: %w", skuConflictErr(err))
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
		    SET name=$2, unit=$3, sku=$4, category_id=NULLIF($5,'')::uuid,
		        default_unit_cost=$6, notes=NULLIF($7,''), is_active=$8
		  WHERE id=$1`,
		id, in.Name, in.Unit, in.SKU, ptrStr(in.CategoryID), in.DefaultUnitCost, in.Notes, in.IsActive)
	if err != nil {
		return fmt.Errorf("update ingredient: %w", skuConflictErr(err))
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
	var inCurrentRecipe int
	if err := r.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recipe_ingredients ri
		   JOIN recipes rec ON rec.current_version_id = ri.version_id
		  WHERE ri.ingredient_id = $1`,
		id,
	).Scan(&inCurrentRecipe); err != nil {
		return fmt.Errorf("check recipe usage: %w", err)
	}
	if inCurrentRecipe > 0 {
		return fmt.Errorf("bahan masih dipakai di resep aktif — hapus dari resep dulu")
	}
	tag, err := r.Pool.Exec(ctx, `DELETE FROM ingredients WHERE id=$1`, id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return fmt.Errorf("bahan masih dipakai di resep produk — hapus dari resep dulu")
		}
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

// IngredientGoodsReceipt is the write-model for receiving ingredients into an outlet or warehouse.
type IngredientGoodsReceipt struct {
	LocKind  string                       `json:"locKind"`
	LocID    string                       `json:"locId"`
	Supplier string                       `json:"supplier,omitempty"`
	Note     string                       `json:"note,omitempty"`
	Items    []IngredientGoodsReceiptItem `json:"items"`
}

// CreateIngredientGoodsReceipt records a goods receipt and credits the location's stock atomically.
// Ingredients are NOT POS-synced, so no content_version bump is needed regardless of location kind.
func (r *Repo) CreateIngredientGoodsReceipt(ctx context.Context, caller string, in IngredientGoodsReceipt) (string, error) {
	if err := validateIngredientGoodsReceipt(in.LocKind, in.Items); err != nil {
		return "", err
	}
	var whID, outID any
	if in.LocKind == "warehouse" {
		whID = in.LocID
	} else {
		outID = in.LocID
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var rid string
	if err := tx.QueryRow(ctx,
		`INSERT INTO ingredient_goods_receipts (warehouse_id, outlet_id, supplier, note, created_by)
         VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,'')::uuid)
         RETURNING id`,
		whID, outID, in.Supplier, in.Note, caller,
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
		if in.LocKind == "warehouse" {
			if _, err := tx.Exec(ctx,
				`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                      VALUES ($1, $2, $3)
                 ON CONFLICT (warehouse_id, ingredient_id)
                 DO UPDATE SET qty = ingredient_warehouse_stock.qty + EXCLUDED.qty`,
				in.LocID, it.IngredientID, it.Qty,
			); err != nil {
				return "", fmt.Errorf("upsert warehouse stock: %w", err)
			}
		} else {
			if _, err := tx.Exec(ctx,
				`INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
                      VALUES ($1, $2, $3)
                 ON CONFLICT (outlet_id, ingredient_id)
                 DO UPDATE SET qty = ingredient_outlet_stock.qty + EXCLUDED.qty`,
				in.LocID, it.IngredientID, it.Qty,
			); err != nil {
				return "", fmt.Errorf("upsert outlet stock: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return rid, nil
}

// ── Ingredient categories ──────────────────────────────────

// IngredientCategory is the write-model for the ingredient_categories table.
type IngredientCategory struct {
	Name      string `json:"name"`
	SortOrder *int   `json:"sortOrder,omitempty"`
}

func (r *Repo) CreateIngredientCategory(ctx context.Context, in IngredientCategory) (string, error) {
	if in.Name == "" {
		return "", fmt.Errorf("nama kategori wajib")
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO ingredient_categories (name, sort_order) VALUES ($1, $2) RETURNING id`,
		in.Name, in.SortOrder,
	).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return "", fmt.Errorf("nama kategori sudah dipakai")
		}
		return "", fmt.Errorf("create ingredient category: %w", err)
	}
	return id, nil
}

func (r *Repo) UpdateIngredientCategory(ctx context.Context, id string, in IngredientCategory) error {
	if in.Name == "" {
		return fmt.Errorf("nama kategori wajib")
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE ingredient_categories SET name=$2, sort_order=$3 WHERE id=$1`,
		id, in.Name, in.SortOrder)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return fmt.Errorf("nama kategori sudah dipakai")
		}
		return fmt.Errorf("update ingredient category: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteIngredientCategory(ctx context.Context, id string) error {
	// FK is ON DELETE SET NULL, so deletion is safe — orphaned ingredients
	// simply lose their category_id.
	tag, err := r.Pool.Exec(ctx, `DELETE FROM ingredient_categories WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete ingredient category: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// IngredientAdjust is the write-model for a manual stock adjustment.
type IngredientAdjust struct {
	LocKind      string  `json:"locKind"`
	LocID        string  `json:"locId"`
	IngredientID string  `json:"ingredientId"`
	NewQty       float64 `json:"newQty"`
	Reason       string  `json:"reason"`
}

// AdjustIngredientStock sets the absolute stock qty for an outlet or warehouse and logs the adjustment.
// Ingredients are NOT POS-synced, so no content_version bump is needed.
func (r *Repo) AdjustIngredientStock(ctx context.Context, caller string, in IngredientAdjust) error {
	if err := validateIngredientLocationAdjust(in.LocKind, in.NewQty, in.Reason); err != nil {
		return err
	}
	if in.IngredientID == "" {
		return fmt.Errorf("bahan wajib")
	}
	var whID, outID any
	if in.LocKind == "warehouse" {
		whID = in.LocID
	} else {
		outID = in.LocID
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	if in.LocKind == "warehouse" {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_warehouse_stock (warehouse_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, ingredient_id)
             DO UPDATE SET qty = EXCLUDED.qty`,
			in.LocID, in.IngredientID, in.NewQty,
		); err != nil {
			return fmt.Errorf("upsert warehouse stock: %w", err)
		}
	} else {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_outlet_stock (outlet_id, ingredient_id, qty)
                  VALUES ($1, $2, $3)
             ON CONFLICT (outlet_id, ingredient_id)
             DO UPDATE SET qty = EXCLUDED.qty`,
			in.LocID, in.IngredientID, in.NewQty,
		); err != nil {
			return fmt.Errorf("upsert outlet stock: %w", err)
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ingredient_stock_adjustments (warehouse_id, outlet_id, ingredient_id, new_qty, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, NULLIF($6,'')::uuid)`,
		whID, outID, in.IngredientID, in.NewQty, in.Reason, caller,
	); err != nil {
		return fmt.Errorf("insert adjustment: %w", err)
	}
	return tx.Commit(ctx)
}
