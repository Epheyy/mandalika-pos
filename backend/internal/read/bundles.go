package read

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

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
// bottles for (so the Backoffice knows which line columns to show). Every group's prices, the
// outlets' groups and the save revision are read in one snapshot, so the revision is never newer
// than the prices sent with it; the top-level standard/linePrices are the default group's.
func (r *Repo) BundleSettings(ctx context.Context) (api.BundleSettings, error) {
	snap, err := r.loadBundleSnapshot(ctx)
	if err != nil {
		return api.BundleSettings{}, err
	}
	p := snap.defaultPrices()
	// The lines to price are those of every large-size candidate, so a fresh install (no standard
	// price yet) still shows its ERP lines: price the default sizes at 1 for this lookup only.
	lookup := bundles.Prices{Standard: map[string]float64{}}
	for _, size := range bundles.DefaultLargeSizes {
		lookup.Standard[size] = 1
	}
	for size, price := range p.Standard {
		lookup.Standard[size] = price
	}
	cat, err := r.deriveBundles(ctx, Scope{CrossAll: true}, lookup)
	if err != nil {
		return api.BundleSettings{}, err
	}
	out := api.BundleSettings{
		Revision: snap.revision,
		Groups:   snap.groups,
		Outlets:  snap.outlets,
		Lines:    bundleLines(withStoredLines(cat.Lines, p)),
	}
	out.Standard, out.LinePrices = priceEntries(p)
	return out, nil
}

// bundleSnapshot is the group-related bundle settings read from one transaction.
type bundleSnapshot struct {
	revision int64
	groups   []api.BundlePriceGroup
	outlets  []api.BundleOutletGroup
	prices   map[openapi_types.UUID]bundles.Prices // each group's own rows, not overlaid
}

func (s bundleSnapshot) defaultPrices() bundles.Prices {
	for _, g := range s.groups {
		if g.IsDefault {
			return s.prices[g.Id]
		}
	}
	return bundles.Prices{Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
}

// loadBundleSnapshot reads revision, groups, their price rows and the outlets in one read-only
// repeatable-read transaction.
func (r *Repo) loadBundleSnapshot(ctx context.Context) (bundleSnapshot, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return bundleSnapshot{}, fmt.Errorf("bundle settings snapshot: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only; nothing to undo
	snap := bundleSnapshot{
		groups:  []api.BundlePriceGroup{},
		outlets: []api.BundleOutletGroup{},
		prices:  map[openapi_types.UUID]bundles.Prices{},
	}
	if err := tx.QueryRow(ctx, `SELECT revision FROM bundle_price_revision`).Scan(&snap.revision); err != nil {
		return bundleSnapshot{}, fmt.Errorf("bundle revision: %w", err)
	}

	// outletCount counts inactive outlets too; an outlet without a group is in the default one.
	rows, err := tx.Query(ctx, `
		SELECT g.id, g.name, g.is_default,
		       (SELECT count(*) FROM outlets o
		         WHERE COALESCE(o.price_group_id, (SELECT id FROM price_groups WHERE is_default)) = g.id)::int
		FROM price_groups g ORDER BY g.sort_order, g.name`)
	if err != nil {
		return bundleSnapshot{}, fmt.Errorf("bundle groups: %w", err)
	}
	for rows.Next() {
		var g api.BundlePriceGroup
		if err := rows.Scan(&g.Id, &g.Name, &g.IsDefault, &g.OutletCount); err != nil {
			rows.Close()
			return bundleSnapshot{}, fmt.Errorf("bundle groups scan: %w", err)
		}
		snap.prices[g.Id] = bundles.Prices{Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
		snap.groups = append(snap.groups, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return bundleSnapshot{}, err
	}

	rows, err = tx.Query(ctx, `SELECT group_id, line, size, price::float8 FROM bundle_prices`)
	if err != nil {
		return bundleSnapshot{}, fmt.Errorf("bundle prices: %w", err)
	}
	for rows.Next() {
		var gid openapi_types.UUID
		var line, size string
		var price float64
		if err := rows.Scan(&gid, &line, &size, &price); err != nil {
			rows.Close()
			return bundleSnapshot{}, fmt.Errorf("bundle prices scan: %w", err)
		}
		p, ok := snap.prices[gid]
		if !ok {
			continue
		}
		if line == "" {
			p.Standard[size] = price
			continue
		}
		if p.Lines[line] == nil {
			p.Lines[line] = map[string]float64{}
		}
		p.Lines[line][size] = price
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return bundleSnapshot{}, err
	}
	for i := range snap.groups {
		g := &snap.groups[i]
		g.Standard, g.LinePrices = priceEntries(snap.prices[g.Id])
	}

	rows, err = tx.Query(ctx, `
		SELECT o.id, o.name, COALESCE(o.code, ''), o.is_active,
		       COALESCE(o.price_group_id, (SELECT id FROM price_groups WHERE is_default))
		FROM outlets o ORDER BY o.is_active DESC, o.name, o.id`)
	if err != nil {
		return bundleSnapshot{}, fmt.Errorf("bundle outlets: %w", err)
	}
	for rows.Next() {
		var o api.BundleOutletGroup
		if err := rows.Scan(&o.OutletId, &o.Name, &o.Code, &o.IsActive, &o.GroupId); err != nil {
			rows.Close()
			return bundleSnapshot{}, fmt.Errorf("bundle outlets scan: %w", err)
		}
		snap.outlets = append(snap.outlets, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return bundleSnapshot{}, err
	}
	return snap, nil
}

// priceEntries lists a group's standard prices (by size) and line prices (by line, then size).
func priceEntries(p bundles.Prices) ([]api.BundlePriceEntry, []api.BundleLinePriceEntry) {
	standard := []api.BundlePriceEntry{}
	for _, size := range p.LargeSizes() {
		standard = append(standard, api.BundlePriceEntry{Size: size, Price: p.Standard[size]})
	}
	linePrices := []api.BundleLinePriceEntry{}
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
			linePrices = append(linePrices, api.BundleLinePriceEntry{Line: l, Size: s, Price: p.Lines[l][s]})
		}
	}
	return standard, linePrices
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
	outlet := ""
	if !sc.CrossAll {
		outlet = sc.OutletID
	}
	p, err := bundles.LoadPrices(ctx, r.Pool, outlet)
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

// withStoredLines adds lines that still have a stored price, so a price never loses its field when its
// last large bottle goes inactive.
func withStoredLines(lines []string, p bundles.Prices) []string {
	seen := map[string]bool{}
	for _, l := range lines {
		seen[l] = true
	}
	out := append([]string{}, lines...)
	for l := range p.Lines {
		if !seen[l] {
			out = append(out, l)
		}
	}
	sort.Strings(out)
	return out
}
