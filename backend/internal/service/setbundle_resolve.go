package service

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/bundles"
)

// variantRef names one variant of one product.
type variantRef struct{ productID, size string }

// loadSetBundleVariants reads the variants a sale's bundle pieces name, with the outlet price
// (outlet override, else the product price). A variant that does not exist is simply absent.
func loadSetBundleVariants(ctx context.Context, tx pgx.Tx, outletID string, refs []variantRef) (map[variantRef]bundles.Variant, error) {
	out := make(map[variantRef]bundles.Variant, len(refs))
	if len(refs) == 0 {
		return out, nil
	}
	pids := make([]string, len(refs))
	sizes := make([]string, len(refs))
	for i, r := range refs {
		pids[i], sizes[i] = r.productID, r.size
	}
	rows, err := tx.Query(ctx, `
		SELECT p.id::text, p.name, v.size, COALESCE(v.erp_category,''), v.erp_slug IS NOT NULL,
		       COALESCE(op.price, v.price)::float8, (v.is_active AND p.is_active)
		  FROM product_variants v
		  JOIN products p ON p.id = v.product_id
		  LEFT JOIN outlet_variant_price op
		    ON op.outlet_id = $1 AND op.product_id = v.product_id AND op.variant_size = v.size
		 WHERE (p.id::text, v.size) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
		outletID, pids, sizes)
	if err != nil {
		return nil, fmt.Errorf("load bundle variants: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var v bundles.Variant
		if err := rows.Scan(&v.ProductID, &v.ProductName, &v.Label, &v.ErpCategory, &v.ErpLinked, &v.Price, &v.Active); err != nil {
			return nil, fmt.Errorf("scan bundle variant: %w", err)
		}
		out[variantRef{v.ProductID, v.Label}] = v
	}
	return out, rows.Err()
}

// buildSetBundleGroups collects the bundle lines of a sale by group number (ascending).
func buildSetBundleGroups(items []OrderItem, variants map[variantRef]bundles.Variant, prices bundles.Prices) []setBundleGroup {
	byGroup := map[int]*setBundleGroup{}
	for i, it := range items {
		if it.BundleGroup <= 0 {
			continue
		}
		g := byGroup[it.BundleGroup]
		if g == nil {
			g = &setBundleGroup{group: it.BundleGroup}
			byGroup[it.BundleGroup] = g
		}
		p := setBundlePiece{
			idx: i, role: bundles.Role(it.BundleRole), clientBasis: int64(math.Round(it.BundleBasisPrice)),
		}
		if v, ok := variants[variantRef{it.ProductID, it.VariantSize}]; ok {
			p.catalogBasis = int64(math.Round(v.Price))
			p.piece, p.classified = bundles.Classify(v, prices)
		}
		g.pieces = append(g.pieces, p)
	}
	groups := make([]setBundleGroup, 0, len(byGroup))
	for _, g := range byGroup {
		// the list price is the large piece's; every piece must carry the same one
		for _, p := range g.pieces {
			if p.role == bundles.RoleLarge {
				g.clientPrice = items[p.idx].BundlePrice
			}
		}
		for _, p := range g.pieces {
			if items[p.idx].BundlePrice != g.clientPrice {
				g.mismatch = true
			}
		}
		groups = append(groups, *g)
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].group < groups[j].group })
	return groups
}

// resolveSetBundles validates every bundle group of the sale, reprices its pieces to their share
// of the bundle price and records what the server resolved. Online, an invalid group is a 422.
// For a synced sale an invalid group is kept as the tablet captured it (a physical sale that
// already happened) and flagged; the pieces keep their group so the refund group still forms.
// The returned warn reason is joined into the order's discount_warning_reason.
func (s *OrderService) resolveSetBundles(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) (string, error) {
	var refs []variantRef
	has := false
	for _, it := range in.Items {
		if it.BundleGroup > 0 {
			has = true
			refs = append(refs, variantRef{it.ProductID, it.VariantSize})
		}
	}
	if !has {
		return "", nil
	}
	prices, err := bundles.LoadPrices(ctx, tx)
	if err != nil {
		return "", err
	}
	variants, err := loadSetBundleVariants(ctx, tx, in.OutletID, refs)
	if err != nil {
		return "", err
	}
	var warns []PromoViolation
	seen := map[PromoViolation]bool{}
	addWarns := func(vs []PromoViolation) {
		for _, v := range vs {
			if !seen[v] {
				seen[v] = true
				warns = append(warns, v)
			}
		}
	}
	for _, g := range buildSetBundleGroups(in.Items, variants, prices) {
		priced, vios := priceSetBundle(g, prices, in.Offline)
		if !priced.ok {
			if !in.Offline {
				return "", &ErrDiscountRejected{Violations: vios}
			}
			slog.Warn("keeping unvalidated bundle (offline)", "group", g.group, "violations", JoinViolations(vios))
			addWarns(vios)
			line, size := keptBundleLineSize(g)
			for _, p := range g.pieces {
				in.Items[p.idx].bundle = &setBundleInfo{line: line, size: size}
			}
			continue
		}
		addWarns(vios)
		for _, p := range g.pieces {
			ri := roleIndex[p.role]
			it := &in.Items[p.idx]
			it.Price = float64(priced.shares[ri])
			it.Subtotal = it.Price
			it.bundle = &setBundleInfo{
				line: priced.line, size: priced.size,
				discount: float64(priced.discShares[ri]), promotionID: priced.promotionID,
			}
		}
	}
	return JoinViolations(warns), nil
}

// keptBundleLineSize is the line and size of an unvalidated group, from whatever classified.
func keptBundleLineSize(g setBundleGroup) (line, size string) {
	for _, p := range g.pieces {
		if p.role == bundles.RoleLarge && p.classified {
			return p.piece.Line, p.piece.Size
		}
	}
	return "", ""
}

// bundleColumns are the six order_items bundle columns (nil = SQL NULL). A line outside a
// bundle writes all NULL, which the (group IS NULL) = (role IS NULL) check requires.
func (it OrderItem) bundleColumns() [6]any {
	if it.BundleGroup <= 0 {
		return [6]any{}
	}
	var line, size string
	var discount float64
	var promo any
	if it.bundle != nil {
		line, size, discount = it.bundle.line, it.bundle.size, it.bundle.discount
		promo = nullStr(it.bundle.promotionID)
	}
	return [6]any{it.BundleGroup, it.BundleRole, line, size, discount, promo}
}
