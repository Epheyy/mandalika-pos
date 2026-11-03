package read

import (
	"context"
	"fmt"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
)

// LowStockThreshold is the per-variant "stok rendah" line (D-81, same as the POS).
const LowStockThreshold = 2

// ProductFilter narrows the backoffice product list; the zero value matches everything.
// Stock is "low" (an active variant with 1..LowStockThreshold in stock) or "out" (an active
// variant with none left); Sort is "terbaru" (default) or "nama". Stock is the scoped outlet's,
// or the sum over every outlet when the scope is cross-outlet (as productObjScoped reports it).
type ProductFilter struct {
	Q          string
	CategoryID string
	Active     *bool
	Stock      string
	Sort       string
}

// IsZero reports whether no filter or sort is set, so the caller can keep the unfiltered query.
func (f ProductFilter) IsZero() bool {
	return f.Q == "" && f.CategoryID == "" && f.Active == nil && f.Stock == "" && f.Sort == ""
}

// likePattern turns a user search into a contains pattern, escaping LIKE wildcards.
func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`,`%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

// ProductsFiltered is Products plus the backoffice filters. Products stays as it is: the tablet
// pull calls it directly and must not change.
func (r *Repo) ProductsFiltered(ctx context.Context, sc Scope, page, limit int, f ProductFilter) ([]api.Product, int, error) {
	scoped := !(sc.CrossAll || sc.OutletID == "")
	var args []any
	where := ` WHERE true` + sellableWhere(sc)
	variantStock := `COALESCE((SELECT SUM(s.stock)::int FROM outlet_variant_stock s
	     WHERE s.product_id=fv.product_id AND s.variant_size=fv.size),0)`
	if scoped {
		args = append(args, sc.OutletID)
		where += availabilityWhere(sc, 1)
		variantStock = `COALESCE((SELECT os.stock FROM outlet_variant_stock os
	     WHERE os.outlet_id=$1 AND os.product_id=fv.product_id AND os.variant_size=fv.size),0)`
	}
	arg := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	if f.Q != "" {
		n := arg(likePattern(f.Q))
		where += fmt.Sprintf(` AND (p.name ILIKE $%[1]d OR p.brand ILIKE $%[1]d OR EXISTS (SELECT 1 FROM product_variants qv
	   WHERE qv.product_id=p.id AND (qv.sku ILIKE $%[1]d OR qv.barcode ILIKE $%[1]d)))`, n)
	}
	if f.CategoryID != "" {
		where += fmt.Sprintf(` AND p.category_id = $%d::uuid`, arg(f.CategoryID))
	}
	if f.Active != nil {
		where += fmt.Sprintf(` AND p.is_active = $%d`, arg(*f.Active))
	}
	switch f.Stock {
	case "low":
		where += fmt.Sprintf(` AND EXISTS (SELECT 1 FROM product_variants fv WHERE fv.product_id=p.id AND fv.is_active
	   AND %s BETWEEN 1 AND %d)`, variantStock, LowStockThreshold)
	case "out":
		where += fmt.Sprintf(` AND EXISTS (SELECT 1 FROM product_variants fv WHERE fv.product_id=p.id AND fv.is_active
	   AND %s <= 0)`, variantStock)
	}
	order := `ORDER BY p.created_at DESC, p.id DESC`
	if f.Sort == "nama" {
		order = `ORDER BY lower(p.name), p.id`
	}
	lim, offs := arg(limit), arg(off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM products p%s %s LIMIT $%d OFFSET $%d`,
		productObjScoped(sc), where, order, lim, offs)
	return listJSON[api.Product](ctx, r.Pool, sql, args...)
}
