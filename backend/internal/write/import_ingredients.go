package write

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// planIngredientImport loads the ingredient catalog once and plans the file against it.
// Ingredient stock is never read or written, and (like the other ingredient writes) the
// import does not bump the content version: ingredients are backoffice-only, not POS-synced.
func planIngredientImport(ctx context.Context, q pgx.Tx, t *csvimport.Table) (*importPlan, error) {
	var cat csvimport.IngredientCatalog
	rows, err := q.Query(ctx, `
		SELECT id::text, name, sku, unit, COALESCE(category_id::text,''), COALESCE(notes,''),
		       default_unit_cost::float8, is_active
		  FROM ingredients`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var i csvimport.CatalogIngredient
		if err = rows.Scan(&i.ID, &i.Name, &i.SKU, &i.Unit, &i.CategoryID, &i.Notes, &i.Cost, &i.Active); err != nil {
			rows.Close()
			return nil, err
		}
		cat.Ingredients = append(cat.Ingredients, i)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.Query(ctx, `SELECT id::text, name FROM ingredient_categories ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var c csvimport.CatalogCategory
		if err = rows.Scan(&c.ID, &c.Name); err != nil {
			rows.Close()
			return nil, err
		}
		cat.Categories = append(cat.Categories, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}

	plan, err := csvimport.PlanIngredients(t, cat)
	if err != nil {
		return nil, err
	}
	return &importPlan{report: plan.Report, apply: func(ctx context.Context, tx pgx.Tx) error {
		return applyIngredientPlan(ctx, tx, plan)
	}}, nil
}

func applyIngredientPlan(ctx context.Context, tx pgx.Tx, plan *csvimport.IngredientsPlan) error {
	if len(plan.NewCategories) > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO ingredient_categories (name) SELECT n FROM unnest($1::text[]) AS t(n)
			 ON CONFLICT (name) DO NOTHING`, plan.NewCategories); err != nil {
			return err
		}
	}
	catIDs := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT name, id::text FROM ingredient_categories ORDER BY id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name, id string
		if err = rows.Scan(&name, &id); err != nil {
			rows.Close()
			return err
		}
		key := strings.ToLower(strings.TrimSpace(name)) // planner's folding, not the database locale
		if _, ok := catIDs[key]; !ok {                  // first (lowest id) wins, as in the planner
			catIDs[key] = id
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}

	var (
		cName, cSKU, cUnit []string
		cCat, cNotes       []*string
		cCost              []*float64
		cActive            []bool
		uID, uName, uSKU   []string
		uUnit              []string
		uCat, uNotes       []*string
		uCost              []*float64
		uActive            []*bool
	)
	for _, p := range plan.Ingredients {
		cat := categoryArg(catIDs, p.CategoryName)
		if p.ExistingID == "" {
			cName, cSKU, cUnit = append(cName, p.Name), append(cSKU, p.SKU), append(cUnit, p.Unit)
			cCat, cNotes, cCost = append(cCat, cat), append(cNotes, p.Notes), append(cCost, p.Cost)
			cActive = append(cActive, *p.Active)
			continue
		}
		uID, uName, uSKU, uUnit = append(uID, p.ExistingID), append(uName, p.Name), append(uSKU, p.SKU), append(uUnit, p.Unit)
		uCat, uNotes, uCost, uActive = append(uCat, cat), append(uNotes, p.Notes), append(uCost, p.Cost), append(uActive, p.Active)
	}
	if len(cName) > 0 {
		if _, err = tx.Exec(ctx, `
			INSERT INTO ingredients (name, unit, sku, category_id, default_unit_cost, notes, is_active)
			SELECT t.n, t.u, t.k, t.c::uuid, t.d, NULLIF(t.o,''), t.a
			  FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::numeric[],$6::text[],$7::bool[]) AS t(n,u,k,c,d,o,a)`,
			cName, cUnit, cSKU, cCat, cCost, cNotes, cActive); err != nil {
			return err
		}
	}
	if len(uID) > 0 {
		// Blank / nil = keep the stored value; stock tables are never touched.
		if _, err = tx.Exec(ctx, `
			UPDATE ingredients i SET
			       name = COALESCE(NULLIF(u.n,''), i.name),
			       unit = COALESCE(NULLIF(u.un,''), i.unit),
			       sku = COALESCE(NULLIF(u.k,''), i.sku),
			       category_id = COALESCE(u.c::uuid, i.category_id),
			       default_unit_cost = COALESCE(u.d, i.default_unit_cost),
			       notes = COALESCE(u.o, i.notes),
			       is_active = COALESCE(u.a, i.is_active)
			  FROM unnest($1::uuid[],$2::text[],$3::text[],$4::text[],$5::text[],$6::numeric[],$7::text[],$8::bool[]) AS u(id,n,k,un,c,d,o,a)
			 WHERE i.id = u.id`,
			uID, uName, uSKU, uUnit, uCat, uCost, uNotes, uActive); err != nil {
			return err
		}
	}
	return nil
}
