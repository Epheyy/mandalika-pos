package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// productObjScoped builds the product JSON with per-outlet stock/price resolved.
// When sc.OutletID != "" the variant stock/price resolve to that outlet (0 / base
// when no row) and unavailable products are excluded by the caller's WHERE; the
// outlet id is passed as $1. Otherwise (CrossAll/admin "all") stock is summed
// across outlets and the base variant price is used.
func productObjScoped(sc Scope) string {
	if sc.CrossAll || sc.OutletID == "" {
		return `json_build_object(
		  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
		  'description',p.description,'imageUrl',p.image_url,
	  'images',p.images,'sellable',p.sellable,
		  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
		  'createdAt',p.created_at,
		  'variants',COALESCE((SELECT json_agg(json_build_object(
		     'id',v.id,'size',v.size,'price',v.price,'basePrice',v.price,
		     'stock',COALESCE((SELECT SUM(s.stock)::int FROM outlet_variant_stock s
		        WHERE s.product_id=v.product_id AND s.variant_size=v.size),0),
		     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
		     FROM product_variants v WHERE v.product_id=p.id),'[]'::json))`
	}
	return `json_build_object(
	  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
	  'description',p.description,'imageUrl',p.image_url,
	  'images',p.images,'sellable',p.sellable,
	  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
	  'createdAt',p.created_at,
	  'variants',COALESCE((SELECT json_agg(json_build_object(
	     'size',v.size,'basePrice',v.price,
	     'price',COALESCE((SELECT op.price FROM outlet_variant_price op
	        WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size), v.price),
	     'stock',COALESCE((SELECT os.stock FROM outlet_variant_stock os
	        WHERE os.outlet_id=$1 AND os.product_id=v.product_id AND os.variant_size=v.size),0),
	     'parLevel',(SELECT op.par_level FROM outlet_variant_stock op
	        WHERE op.outlet_id=$1 AND op.product_id=v.product_id AND op.variant_size=v.size),
	     'sku',v.sku,'barcode',v.barcode) ORDER BY v.size)
	     FROM product_variants v WHERE v.product_id=p.id
	     AND COALESCE((SELECT oa.available FROM outlet_variant_stock oa
	        WHERE oa.outlet_id=$1 AND oa.product_id=v.product_id AND oa.variant_size=v.size), true)),'[]'::json))`
}

// availabilityWhere keeps a product only if it has at least one variant available
// at the scoped outlet ($argPos) — i.e. drops products whose every variant is
// turned off there.
func availabilityWhere(sc Scope, argPos int) string {
	if sc.CrossAll || sc.OutletID == "" {
		return ""
	}
	return fmt.Sprintf(` AND EXISTS (SELECT 1 FROM product_variants v2
	   WHERE v2.product_id=p.id
	     AND COALESCE((SELECT oa.available FROM outlet_variant_stock oa
	        WHERE oa.outlet_id=$%d AND oa.product_id=v2.product_id AND oa.variant_size=v2.size), true))`, argPos)
}

// sellableWhere hides not-for-customer products (POS pull only).
func sellableWhere(sc Scope) string {
	if sc.SellableOnly {
		return ` AND p.sellable`
	}
	return ""
}

func (r *Repo) Products(ctx context.Context, sc Scope, page, limit int) ([]api.Product, int, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return listJSON[api.Product](ctx, r.Pool,
			`SELECT `+obj+`, count(*) OVER() AS total
			   FROM products p WHERE true`+sellableWhere(sc)+`
			   ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $2`,
			limit, off(page, limit))
	}
	return listJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+`, count(*) OVER() AS total
		   FROM products p WHERE true`+availabilityWhere(sc, 1)+sellableWhere(sc)+`
		   ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
		sc.OutletID, limit, off(page, limit))
}

func (r *Repo) Product(ctx context.Context, sc Scope, id string) (api.Product, error) {
	obj := productObjScoped(sc)
	if sc.CrossAll || sc.OutletID == "" {
		return oneJSON[api.Product](ctx, r.Pool, `SELECT `+obj+` FROM products p WHERE p.id=$1`, id)
	}
	return oneJSON[api.Product](ctx, r.Pool,
		`SELECT `+obj+` FROM products p WHERE p.id=$2`, sc.OutletID, id)
}

// ProductOutletConfig returns the per-outlet stock/price/availability matrix for
// one product: a row per active outlet × variant. stock defaults 0, price is
// null when there's no override, available defaults true.
func (r *Repo) ProductOutletConfig(ctx context.Context, productID string) ([]api.OutletVariantConfig, error) {
	rows, _, err := listJSON[api.OutletVariantConfig](ctx, r.Pool, `
		SELECT json_build_object(
		  'outletId', o.id, 'outletName', o.name, 'variantSize', v.size,
		  'stock', COALESCE(s.stock, 0),
		  'price', op.price,
		  'parLevel', s.par_level,
		  'available', COALESCE(s.available, true))
		FROM outlets o
		CROSS JOIN product_variants v
		LEFT JOIN outlet_variant_stock s
		  ON s.outlet_id=o.id AND s.product_id=v.product_id AND s.variant_size=v.size
		LEFT JOIN outlet_variant_price op
		  ON op.outlet_id=o.id AND op.product_id=v.product_id AND op.variant_size=v.size
		WHERE v.product_id=$1 AND o.is_active
		ORDER BY o.name, v.size`, productID)
	return rows, err
}

func (r *Repo) Categories(ctx context.Context) ([]api.Category, int, error) {
	return listJSON[api.Category](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'sortOrder',sort_order) FROM categories ORDER BY sort_order NULLS LAST, name`)
}

func (r *Repo) Bundles(ctx context.Context) ([]api.Bundle, int, error) {
	return listJSON[api.Bundle](ctx, r.Pool,
		`SELECT json_build_object('id',b.id,'name',b.name,'description',b.description,
		   'price',b.price,'imageUrl',b.image_url,'isActive',b.is_active,
		   'createdAt',b.created_at,
		   'items',COALESCE((SELECT json_agg(json_build_object(
		     'productId',i.product_id,'productName',i.product_name,
		     'variantSize',i.variant_size,'quantity',i.quantity,'price',i.price))
		     FROM bundle_items i WHERE i.bundle_id=b.id),'[]'::json))
		   FROM bundles b ORDER BY b.created_at DESC`)
}
