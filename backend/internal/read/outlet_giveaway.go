package read

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
)

// OutletGiveawayOn returns the outlet's per-sale giveaway setting. An outlet with no
// setting yields configured=false (not an error); an unknown outlet is ErrNotFound.
// The caller applies the outlet scope. erpMapped uses the ERP builder's own test
// (erp_slug set and a non-empty sku); valid is false when the variant is gone.
func OutletGiveawayOn(ctx context.Context, q RowQuerier, outletID string) (api.OutletGiveaway, error) {
	oid, err := uuid.Parse(outletID)
	if err != nil {
		return api.OutletGiveaway{}, ErrNotFound
	}
	var exists bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM outlets WHERE id=$1)`, oid).Scan(&exists); err != nil {
		return api.OutletGiveaway{}, fmt.Errorf("query: %w", err)
	}
	if !exists {
		return api.OutletGiveaway{}, ErrNotFound
	}
	out := api.OutletGiveaway{OutletId: openapi_types.UUID(oid)}
	var (
		pid        uuid.UUID
		size       string
		enabled    bool
		updatedBy  *uuid.UUID
		updatedAt  time.Time
		name, sku  *string
		slug       *string
		hasVariant bool
	)
	err = q.QueryRow(ctx,
		`SELECT g.product_id, g.variant_size, g.enabled, g.updated_by, g.updated_at,
		        p.name, v.sku, to_jsonb(v)->>'erp_slug', v.id IS NOT NULL
		   FROM outlet_giveaways g
		   LEFT JOIN products p ON p.id = g.product_id
		   LEFT JOIN LATERAL (SELECT * FROM product_variants x
		                       WHERE x.product_id = g.product_id AND x.size = g.variant_size
		                       ORDER BY x.id LIMIT 1) v ON true
		  WHERE g.outlet_id = $1`, oid).
		Scan(&pid, &size, &enabled, &updatedBy, &updatedAt, &name, &sku, &slug, &hasVariant)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return api.OutletGiveaway{}, fmt.Errorf("query: %w", err)
	}
	p := openapi_types.UUID(pid)
	mapped := hasVariant && slug != nil && sku != nil && *sku != ""
	out.Configured, out.Enabled = true, enabled
	out.ProductId, out.VariantSize = &p, &size
	out.ProductName, out.Sku = name, sku
	out.ErpMapped, out.Valid = &mapped, &hasVariant
	out.UpdatedAt = &updatedAt
	if updatedBy != nil {
		u := openapi_types.UUID(*updatedBy)
		out.UpdatedBy = &u
	}
	return out, nil
}
