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

var _ = pgx.ErrNoRows      // keep pgx import used (referenced in the DB methods added in A4)
var _ = context.Background // keep context import used (referenced in the DB methods added in A4)
var _ = fmt.Errorf         // keep fmt import used (referenced in the DB methods added in A4)
