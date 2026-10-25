package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Outlet giveaway (inventory controls S2): the per-sale giveaway item of an outlet. The
// sale path reads it (service/lockorder.go, service/ledger_hooks.go); this file only
// edits the setting. It moves no stock, so it takes no stock lock and writes no ledger row.

// ErrGiveawayVariantMissing refuses a giveaway item that is not a variant.
var ErrGiveawayVariantMissing = apperr.New(apperr.Conflict,
	"varian hadiah tidak ditemukan; pilih produk dan ukuran yang masih ada")

// ErrGiveawayUnmapped refuses an item the ERP does not know while the integration is on:
// the ERP builder would hold every sale document that carries it.
var ErrGiveawayUnmapped = apperr.New(apperr.Conflict,
	"varian hadiah belum dipetakan ke ERP (slug dan SKU kosong); pilih varian yang sudah dipetakan")

// OutletGiveawayInput is the new setting of one outlet.
type OutletGiveawayInput struct {
	ProductID   string
	VariantSize string
	Enabled     bool
}

// SetOutletGiveawayTx upserts the outlet's giveaway setting inside the caller's
// transaction and appends an inventory_doc_events row (doc_type outlet_giveaway, doc_id =
// the outlet id). erpOn is true when the ERP integration is enabled: the variant must then
// be ERP-mapped (erp_slug set and a non-empty sku, the builder's own test). Unknown outlet
// is ErrNotFound. The row lock waits for in-flight sales, which hold it FOR SHARE.
func (r *Repo) SetOutletGiveawayTx(ctx context.Context, tx pgx.Tx, outletID, actor string, in OutletGiveawayInput, erpOn bool) error {
	if _, err := uuid.Parse(outletID); err != nil {
		return ErrNotFound
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM outlets WHERE id=$1)`, outletID).Scan(&exists); err != nil {
		return fmt.Errorf("check outlet: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	var sku string
	var slug *string
	err := tx.QueryRow(ctx,
		`SELECT v.sku, to_jsonb(v)->>'erp_slug' FROM product_variants v
		  WHERE v.product_id=$1 AND v.size=$2 ORDER BY v.id LIMIT 1`,
		in.ProductID, in.VariantSize).Scan(&sku, &slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrGiveawayVariantMissing
	}
	if err != nil {
		return fmt.Errorf("check giveaway variant: %w", err)
	}
	if erpOn && (slug == nil || sku == "") {
		return ErrGiveawayUnmapped
	}
	var prevPID, prevSize string
	var prevEnabled bool
	err = tx.QueryRow(ctx,
		`SELECT product_id::text, variant_size, enabled FROM outlet_giveaways WHERE outlet_id=$1 FOR UPDATE`,
		outletID).Scan(&prevPID, &prevSize, &prevEnabled)
	action := "updated"
	data := map[string]any{"to": map[string]any{"productId": in.ProductID, "variantSize": in.VariantSize, "enabled": in.Enabled}}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		action = "created"
	case err != nil:
		return fmt.Errorf("read giveaway setting: %w", err)
	default:
		data["from"] = map[string]any{"productId": prevPID, "variantSize": prevSize, "enabled": prevEnabled}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO outlet_giveaways (outlet_id, product_id, variant_size, enabled, updated_by, updated_at)
		 VALUES ($1,$2,$3,$4,NULLIF($5,'')::uuid,now())
		 ON CONFLICT (outlet_id) DO UPDATE SET product_id=EXCLUDED.product_id,
		   variant_size=EXCLUDED.variant_size, enabled=EXCLUDED.enabled,
		   updated_by=EXCLUDED.updated_by, updated_at=now()`,
		outletID, in.ProductID, in.VariantSize, in.Enabled, actor); err != nil {
		return fmt.Errorf("save giveaway setting: %w", err)
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO inventory_doc_events (doc_type, doc_id, action, actor_id, data)
		 VALUES ('outlet_giveaway',$1,$2,NULLIF($3,'')::uuid,$4)`,
		outletID, action, actor, raw); err != nil {
		return fmt.Errorf("record giveaway event: %w", err)
	}
	return nil
}
