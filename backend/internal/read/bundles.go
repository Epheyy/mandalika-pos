package read

import (
	"context"
	"fmt"
	"sort"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/bundles"
)

func bundleLines(lines []string) []api.BundleLine {
	out := make([]api.BundleLine, 0, len(lines))
	for _, l := range lines {
		label, short := bundles.LineInfo(l)
		out = append(out, api.BundleLine{Line: l, Label: label, Short: short})
	}
	return out
}

// BundleSettings is the stored bundle price settings plus the lines the catalog has large
// bottles for (so the Backoffice knows which line columns to show).
func (r *Repo) BundleSettings(ctx context.Context) (api.BundleSettings, error) {
	p, err := bundles.LoadPrices(ctx, r.Pool)
	if err != nil {
		return api.BundleSettings{}, err
	}
	cat, err := r.deriveBundles(ctx, Scope{CrossAll: true}, p)
	if err != nil {
		return api.BundleSettings{}, err
	}
	out := api.BundleSettings{
		Standard:   []api.BundlePriceEntry{},
		LinePrices: []api.BundleLinePriceEntry{},
		Lines:      bundleLines(cat.Lines),
	}
	for _, size := range p.LargeSizes() {
		out.Standard = append(out.Standard, api.BundlePriceEntry{Size: size, Price: p.Standard[size]})
	}
	lineNames := make([]string, 0, len(p.Lines))
	for l := range p.Lines {
		lineNames = append(lineNames, l)
	}
	sort.Strings(lineNames)
	for _, l := range lineNames {
		sizes := make([]string, 0, len(p.Lines[l]))
		for s := range p.Lines[l] {
			sizes = append(sizes, s)
		}
		sort.Slice(sizes, func(i, j int) bool { return sizeKey(sizes[i]) < sizeKey(sizes[j]) })
		for _, s := range sizes {
			out.LinePrices = append(out.LinePrices, api.BundleLinePriceEntry{Line: l, Size: s, Price: p.Lines[l][s]})
		}
	}
	return out, nil
}

func sizeKey(size string) int {
	n := 0
	for _, c := range size {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// BundleCatalog is the derived bundle catalog for the scope: tablets get it inside the sync
// pull (sc.SellableOnly, one outlet), the Backoffice gets every product.
func (r *Repo) BundleCatalog(ctx context.Context, sc Scope) (api.BundleCatalog, error) {
	p, err := bundles.LoadPrices(ctx, r.Pool)
	if err != nil {
		return api.BundleCatalog{}, err
	}
	cat, err := r.deriveBundles(ctx, sc, p)
	if err != nil {
		return api.BundleCatalog{}, err
	}
	return toAPICatalog(cat), nil
}

func toAPICatalog(cat bundles.Catalog) api.BundleCatalog {
	out := api.BundleCatalog{
		Lines:    bundleLines(cat.Lines),
		Products: make([]api.BundleCatalogProduct, 0, len(cat.Products)),
		Pieces:   make([]api.BundlePiece, 0, len(cat.Pieces)),
	}
	for _, pb := range cat.Products {
		cp := api.BundleCatalogProduct{
			ProductId: pb.ProductID, ProductName: pb.ProductName,
			Offers:  make([]api.BundleOffer, 0, len(pb.Offers)),
			Missing: make([]api.BundleMissing, 0, len(pb.Missing)),
		}
		for _, o := range pb.Offers {
			label, short := bundles.LineInfo(o.Line)
			cp.Offers = append(cp.Offers, api.BundleOffer{
				Line: o.Line, LineLabel: label, LineShort: short, Size: o.Size, Price: o.Price,
				LargeVariantSize: o.LargeSize, AtomizerVariantSize: o.AtomizerSize, VialVariantSize: o.VialSize,
			})
		}
		for _, m := range pb.Missing {
			cp.Missing = append(cp.Missing, api.BundleMissing{
				Line: m.Line, Size: m.Size, Reason: api.BundleMissingReason(m.Reason), Text: m.Text})
		}
		out.Products = append(out.Products, cp)
	}
	for _, pc := range cat.Pieces {
		out.Pieces = append(out.Pieces, api.BundlePiece{
			ProductId: pc.ProductID, VariantSize: pc.VariantSize, Role: api.BundlePieceRole(pc.Role),
			Line: pc.Line, Size: pc.Size})
	}
	return out
}

// deriveBundles loads the variants in scope and derives the catalog. A tablet scope sees the
// variants the pull sends (active, priced, available at the outlet) and active products only.
func (r *Repo) deriveBundles(ctx context.Context, sc Scope, p bundles.Prices) (bundles.Catalog, error) {
	var (
		sql  string
		args []any
	)
	const cols = `SELECT p.id::text, p.name, v.size, COALESCE(v.erp_category,''),
	       v.erp_slug IS NOT NULL, %s::float8, v.is_active
	  FROM products p JOIN product_variants v ON v.product_id = p.id
	 WHERE p.is_active`
	if sc.CrossAll || sc.OutletID == "" {
		sql = fmt.Sprintf(cols, "v.price") + sellableWhere(sc) + ` ORDER BY p.name, p.id, v.size`
	} else {
		price := `COALESCE((SELECT op.price FROM outlet_variant_price op WHERE op.outlet_id=$1
		     AND op.product_id=v.product_id AND op.variant_size=v.size), v.price)`
		sql = fmt.Sprintf(cols, price) + sellableWhere(sc) + `
		   AND ` + tabletVariantFilter(sc, "v", 1) + `
		   AND COALESCE((SELECT oa.available FROM outlet_variant_stock oa
		        WHERE oa.outlet_id=$1 AND oa.product_id=v.product_id AND oa.variant_size=v.size), true)
		 ORDER BY p.name, p.id, v.size`
		args = []any{sc.OutletID}
	}
	rows, err := r.Pool.Query(ctx, sql, args...)
	if err != nil {
		return bundles.Catalog{}, fmt.Errorf("bundle variants: %w", err)
	}
	defer rows.Close()
	var vs []bundles.Variant
	for rows.Next() {
		var v bundles.Variant
		if err := rows.Scan(&v.ProductID, &v.ProductName, &v.Label, &v.ErpCategory, &v.ErpLinked, &v.Price, &v.Active); err != nil {
			return bundles.Catalog{}, fmt.Errorf("bundle variants scan: %w", err)
		}
		vs = append(vs, v)
	}
	if err := rows.Err(); err != nil {
		return bundles.Catalog{}, err
	}
	return bundles.Derive(vs, p), nil
}
