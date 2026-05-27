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
