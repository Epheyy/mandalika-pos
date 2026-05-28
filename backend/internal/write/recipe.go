package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrVersionConflict signals an optimistic-lock failure (someone else saved a
// newer version between load and save). Mapped to HTTP 409 by the handler.
var ErrVersionConflict = errors.New("resep sudah diubah orang lain. muat ulang")

// RecipeSaveItem is one ingredient line in a save request.
type RecipeSaveItem struct {
	IngredientID string  `json:"ingredientId"`
	Qty          float64 `json:"qty"`
	SortOrder    int     `json:"sortOrder"`
}

// RecipeSave is the write-model for "save a new version".
type RecipeSave struct {
	ExpectedCurrentVersionID *string          `json:"expectedCurrentVersionId,omitempty"`
	Notes                    string           `json:"notes,omitempty"`
	Items                    []RecipeSaveItem `json:"items"`
}

// ingredientSnap is the resolved ingredient data captured at save time.
type ingredientSnap struct {
	name     string
	unit     string
	cost     *float64
	isActive bool
}

// versionMatches implements the optimistic-lock comparison. Both nil (first
// save, no current version) matches; both non-nil and equal matches; anything
// else is a conflict.
func versionMatches(expected, current *string) bool {
	if expected == nil && current == nil {
		return true
	}
	if expected == nil || current == nil {
		return false
	}
	return *expected == *current
}

// computeTotalCost sums qty*cost across lines. Returns nil if ANY line lacks a
// cost (the cost estimate is all-or-nothing, per the locked decision).
func computeTotalCost(items []RecipeSaveItem, snaps map[string]ingredientSnap) *float64 {
	var total float64
	for _, it := range items {
		s, ok := snaps[it.IngredientID]
		if !ok || s.cost == nil {
			return nil
		}
		total += it.Qty * (*s.cost)
	}
	return &total
}

// newlyAddedInactive reports whether a line introduces an inactive ingredient
// that was NOT in the prior current version (a forbidden fresh add). Lines that
// were already present pass (warn-but-allow).
func newlyAddedInactive(ingredientID string, isActive bool, priorIDs map[string]bool) bool {
	return !isActive && !priorIDs[ingredientID]
}

// loadIngredientSnaps fetches name/unit/cost/is_active for the given ingredient
// IDs in one query, fully drained before the caller issues any tx write
// (pgx conn-busy discipline). Returns an error if any ID is unknown.
func loadIngredientSnaps(ctx context.Context, tx pgx.Tx, ids []string) (map[string]ingredientSnap, error) {
	out := make(map[string]ingredientSnap, len(ids))
	rows, err := tx.Query(ctx,
		`SELECT id::text, name, unit, default_unit_cost, is_active
		   FROM ingredients WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("load ingredients: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, unit string
		var cost *float64
		var active bool
		if err := rows.Scan(&id, &name, &unit, &cost, &active); err != nil {
			return nil, fmt.Errorf("scan ingredient: %w", err)
		}
		out[id] = ingredientSnap{name: name, unit: unit, cost: cost, isActive: active}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// priorVersionIngredientIDs returns the set of ingredient IDs in a version
// (used for the warn-but-allow inactive check). Empty set when versionID is nil.
func priorVersionIngredientIDs(ctx context.Context, tx pgx.Tx, versionID *string) (map[string]bool, error) {
	set := map[string]bool{}
	if versionID == nil {
		return set, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT ingredient_id::text FROM recipe_ingredients WHERE version_id = $1`, *versionID)
	if err != nil {
		return nil, fmt.Errorf("load prior version: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan prior id: %w", err)
		}
		set[id] = true
	}
	return set, rows.Err()
}

// insertRecipeVersion writes a new version + its ingredient snapshot and repoints
// recipes.current_version_id, all inside tx. snaps must already be loaded.
// allowInactive skips the newly-added-inactive guard (used by restore).
func (r *Repo) insertRecipeVersion(
	ctx context.Context, tx pgx.Tx, recipeID, caller, notes string,
	items []RecipeSaveItem, snaps map[string]ingredientSnap, priorIDs map[string]bool, allowInactive bool,
) (string, error) {
	for _, it := range items {
		if it.Qty <= 0 {
			return "", fmt.Errorf("qty harus lebih dari 0")
		}
		s, ok := snaps[it.IngredientID]
		if !ok {
			return "", fmt.Errorf("bahan tidak ditemukan")
		}
		if !allowInactive && newlyAddedInactive(it.IngredientID, s.isActive, priorIDs) {
			return "", fmt.Errorf("bahan nonaktif tidak bisa ditambahkan")
		}
	}

	var nextNo int
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(version_no),0)+1 FROM recipe_versions WHERE recipe_id=$1`,
		recipeID,
	).Scan(&nextNo); err != nil {
		return "", fmt.Errorf("next version_no: %w", err)
	}

	total := computeTotalCost(items, snaps)
	var versionID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO recipe_versions (recipe_id, version_no, notes, total_cost_cached, created_by)
		 VALUES ($1, $2, NULLIF($3,''), $4, NULLIF($5,'')::uuid)
		 RETURNING id`,
		recipeID, nextNo, notes, total, caller,
	).Scan(&versionID); err != nil {
		return "", fmt.Errorf("insert version: %w", err)
	}

	for _, it := range items {
		s := snaps[it.IngredientID]
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipe_ingredients
			   (version_id, ingredient_id, qty, name_at_save, unit_at_save, cost_at_save, sort_order)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			versionID, it.IngredientID, it.Qty, s.name, s.unit, s.cost, it.SortOrder,
		); err != nil {
			return "", fmt.Errorf("insert recipe ingredient: %w", err)
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE recipes SET current_version_id=$2 WHERE id=$1`, recipeID, versionID,
	); err != nil {
		return "", fmt.Errorf("repoint current version: %w", err)
	}
	return versionID, nil
}

// resolveRecipe finds or creates the recipe row for a variant (FOR UPDATE) and
// returns its id + current_version_id. Creates the row when missing.
func resolveRecipe(ctx context.Context, tx pgx.Tx, variantID, caller string) (recipeID string, currentVersionID *string, err error) {
	err = tx.QueryRow(ctx,
		`SELECT id::text, current_version_id::text FROM recipes WHERE variant_id=$1 FOR UPDATE`,
		variantID,
	).Scan(&recipeID, &currentVersionID)
	if err == nil {
		return recipeID, currentVersionID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", nil, fmt.Errorf("load recipe: %w", err)
	}
	// First save: ensure the variant exists, then create the recipe row.
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_variants WHERE id=$1)`, variantID).Scan(&exists); err != nil {
		return "", nil, fmt.Errorf("check variant: %w", err)
	}
	if !exists {
		return "", nil, fmt.Errorf("varian tidak ditemukan")
	}
	if err = tx.QueryRow(ctx,
		`INSERT INTO recipes (variant_id, created_by) VALUES ($1, NULLIF($2,'')::uuid) RETURNING id::text`,
		variantID, caller,
	).Scan(&recipeID); err != nil {
		return "", nil, fmt.Errorf("create recipe: %w", err)
	}
	return recipeID, nil, nil
}

// SaveRecipe creates a new version for a variant's recipe (creating the recipe
// on first save). Enforces optimistic locking via expectedCurrentVersionId.
func (r *Repo) SaveRecipe(ctx context.Context, caller, variantID string, in RecipeSave) (string, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	recipeID, currentVersionID, err := resolveRecipe(ctx, tx, variantID, caller)
	if err != nil {
		return "", err
	}
	if !versionMatches(in.ExpectedCurrentVersionID, currentVersionID) {
		return "", ErrVersionConflict
	}

	ids := make([]string, 0, len(in.Items))
	for _, it := range in.Items {
		ids = append(ids, it.IngredientID)
	}
	snaps, err := loadIngredientSnaps(ctx, tx, ids)
	if err != nil {
		return "", err
	}
	priorIDs, err := priorVersionIngredientIDs(ctx, tx, currentVersionID)
	if err != nil {
		return "", err
	}

	versionID, err := r.insertRecipeVersion(ctx, tx, recipeID, caller, in.Notes, in.Items, snaps, priorIDs, false)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return versionID, nil
}
