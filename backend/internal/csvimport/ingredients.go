package csvimport

import (
	"fmt"
	"strings"
)

// IngredientSpec is the ingredient file layout (same headers as the export/template).
var IngredientSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "Nama", Required: true},
		{Key: "SKU"},
		{Key: "Satuan", Required: true},
		{Key: "Kategori"},
		{Key: "Biaya Default"},
		{Key: "Catatan"},
		{Key: "Status"},
	},
}

// CatalogIngredient is one current ingredient.
type CatalogIngredient struct {
	ID, Name, SKU, Unit, CategoryID, Notes string
	Cost                                   *float64
	Active                                 bool
}

// IngredientCatalog is a snapshot of ingredients and ingredient categories.
type IngredientCatalog struct {
	Ingredients []CatalogIngredient
	Categories  []CatalogCategory
}

// PlannedIngredient is one ingredient write. For an existing ingredient empty strings
// and nil pointers mean "keep"; for a new one Active is already defaulted. Ingredient
// stock is never part of an import.
type PlannedIngredient struct {
	ExistingID   string
	Name         string
	SKU          string
	Unit         string
	CategoryName string
	Cost         *float64
	Notes        *string
	Active       *bool
}

// IngredientsPlan is the outcome of planning an ingredient file.
type IngredientsPlan struct {
	Report        Report
	Ingredients   []PlannedIngredient
	NewCategories []string
}

// PlanIngredients validates and plans an ingredient file. A SKU matches by SKU only;
// a row without SKU matches by case-insensitive name. Two matches are an error.
func PlanIngredients(t *Table, cat IngredientCatalog) (*IngredientsPlan, error) {
	b := NewBuilder(KindIngredients, t)
	if t.HasFileError() {
		return &IngredientsPlan{Report: b.Report()}, nil
	}
	bySKU := map[string][]*CatalogIngredient{}
	byName := map[string][]*CatalogIngredient{}
	for i := range cat.Ingredients {
		ing := &cat.Ingredients[i]
		if ing.SKU != "" {
			bySKU[strings.ToLower(ing.SKU)] = append(bySKU[strings.ToLower(ing.SKU)], ing)
		}
		byName[strings.ToLower(strings.TrimSpace(ing.Name))] = append(byName[strings.ToLower(strings.TrimSpace(ing.Name))], ing)
	}
	ix := newCatalogIndex(Catalog{Categories: cat.Categories})
	cats := newCategoryTracker(ix)

	plan := &IngredientsPlan{}
	seen := map[string]int{}
	for _, row := range t.Rows {
		b.Begin(row)
		pi, key, outcome := planIngredientRow(b, row, bySKU, byName, ix, cats, seen)
		if b.RowHasError(row) {
			b.Row(row, ActionError, key, "")
			continue
		}
		if outcome.action == ActionCreate || outcome.action == ActionUpdate {
			plan.Ingredients = append(plan.Ingredients, pi)
		}
		b.Row(row, outcome.action, key, outcome.reason)
	}
	plan.NewCategories = cats.names
	b.NewCategories(len(cats.names))
	plan.Report = b.Report()
	return plan, nil
}

func planIngredientRow(b *Builder, row Row, bySKU, byName map[string][]*CatalogIngredient,
	ix *catalogIndex, cats *categoryTracker, seen map[string]int) (PlannedIngredient, string, rowOutcome) {
	c := row.Cells
	var pi PlannedIngredient
	pi.Name = strings.TrimSpace(c["Nama"])
	pi.SKU = strings.TrimSpace(c["SKU"])
	unit := strings.TrimSpace(c["Satuan"])
	key := pi.SKU
	if key == "" {
		key = pi.Name
	}
	if pi.Name == "" {
		b.Issue(row, "Nama", SevError, "required", "Nama wajib diisi", "")
		return pi, key, rowOutcome{}
	}
	if err := CheckLen(pi.Name, MaxName); err != nil {
		b.Issue(row, "Nama", SevError, "too_long", "Nama "+err.Error(), pi.Name)
	}
	if pi.SKU != "" {
		if err := CheckLen(pi.SKU, MaxCode); err != nil {
			b.Issue(row, "SKU", SevError, "too_long", "SKU "+err.Error(), pi.SKU)
		}
	}
	if unit != "" {
		if err := CheckLen(unit, MaxUnit); err != nil {
			b.Issue(row, "Satuan", SevError, "too_long", "Satuan "+err.Error(), unit)
		}
		pi.Unit = unit
	}
	category := strings.TrimSpace(c["Kategori"])
	if category != "" {
		checkMax(b, row, "Kategori", category, MaxName)
	}
	if raw := strings.TrimSpace(c["Biaya Default"]); raw != "" {
		v, err := ParseRupiah(raw, true)
		if err != nil {
			b.Issue(row, "Biaya Default", SevError, "invalid_number", "Biaya Default: "+err.Error(), raw)
		} else {
			pi.Cost = &v
		}
	}
	if notes := c["Catatan"]; notes != "" {
		checkMax(b, row, "Catatan", notes, MaxText)
		n := notes
		pi.Notes = &n
	}
	if raw := strings.TrimSpace(c["Status"]); raw != "" {
		active, ok := parseStatus(raw)
		if !ok {
			b.Issue(row, "Status", SevError, "invalid_bool", "Status harus Aktif atau Nonaktif", raw)
		} else {
			pi.Active = &active
		}
	}

	dupKey := "name:" + strings.ToLower(pi.Name)
	if pi.SKU != "" {
		dupKey = "sku:" + strings.ToLower(pi.SKU)
	}
	if first, dup := seen[dupKey]; dup {
		b.Issue(row, "SKU", SevError, "duplicate_in_file", fmt.Sprintf("bahan yang sama sudah ada di baris %d", first), key)
	} else {
		seen[dupKey] = row.Index
	}

	var match *CatalogIngredient
	if pi.SKU != "" {
		switch cands := bySKU[strings.ToLower(pi.SKU)]; len(cands) {
		case 0:
			if len(byName[strings.ToLower(pi.Name)]) > 0 {
				b.Issue(row, "Nama", SevWarning, "name_exists",
					"sudah ada bahan dengan nama ini dan SKU lain; baris ini dibuat sebagai bahan baru", pi.Name)
			}
		case 1:
			match = cands[0]
		default:
			b.Issue(row, "SKU", SevError, "ambiguous_match", "lebih dari satu bahan memakai SKU ini", pi.SKU)
		}
	} else {
		switch cands := byName[strings.ToLower(pi.Name)]; len(cands) {
		case 0:
		case 1:
			match = cands[0]
		default:
			b.Issue(row, "Nama", SevError, "ambiguous_match", fmt.Sprintf("%d bahan bernama sama; isi SKU untuk memilih salah satu", len(cands)), pi.Name)
		}
	}
	if b.RowHasError(row) {
		return pi, key, rowOutcome{}
	}

	if category != "" {
		pi.CategoryName = category
	}
	catID := ""
	if category != "" {
		catID = cats.resolve(category)
	}
	if match == nil {
		if unit == "" {
			b.Issue(row, "Satuan", SevError, "required", "Satuan wajib diisi untuk bahan baru", "")
			return pi, key, rowOutcome{}
		}
		active := true
		if pi.Active != nil {
			active = *pi.Active
		}
		pi.Active = &active
		return pi, key, rowOutcome{ActionCreate, ""}
	}

	pi.ExistingID = match.ID
	changed := false
	if pi.SKU == "" {
		pi.Name = match.Name // matched by name: the stored spelling stays
	} else if pi.Name != match.Name {
		changed = true
	}
	if unit != "" && unit != match.Unit {
		changed = true
	}
	if pi.SKU != "" && pi.SKU != match.SKU {
		changed = true
	}
	if category != "" && (catID == "" || catID != match.CategoryID) { // a new category always counts
		changed = true
	}
	if pi.Cost != nil && (match.Cost == nil || *match.Cost != *pi.Cost) {
		changed = true
	}
	if pi.Notes != nil && *pi.Notes != match.Notes {
		changed = true
	}
	if pi.Active != nil && *pi.Active != match.Active {
		changed = true
	}
	if !changed {
		return pi, key, rowOutcome{ActionSkip, noChange}
	}
	return pi, key, rowOutcome{ActionUpdate, ""}
}

func parseStatus(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "aktif":
		return true, true
	case "nonaktif", "non-aktif", "tidak aktif":
		return false, true
	}
	v, err := ParseBool(s)
	return v, err == nil
}
