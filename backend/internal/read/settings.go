package read

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

func (r *Repo) AppSettings(ctx context.Context) (api.AppSettings, error) {
	return oneJSON[api.AppSettings](ctx, r.Pool,
		`SELECT json_build_object('taxEnabled',tax_enabled,'taxRate',tax_rate,
		   'roundingEnabled',rounding_enabled,'roundingType',rounding_type,
		   'roundingAmount',rounding_amount,'roundingDirection',rounding_direction,
		   'roundingApplyToTax',rounding_apply_to_tax,'autoOpenShift',auto_open_shift,'allowNegativeStock',allow_negative_stock,
		   'paymentMethods',payment_methods,'receipt',receipt,
		   'receiveApproverRoles',receive_approver_roles,
		   'recipesEnabled',recipes_enabled,
		   'splitTenderEnabled',split_tender_enabled,
		   'inventoryApprovalRequired',inventory_approval_required,
		   'documents',json_build_object(
		     'logoUrl',documents_logo_url,
		     'brandName',documents_brand_name,
		     'addressLines',documents_address_lines,
		     'phone',documents_phone,
		     'npwp',documents_npwp))
		   FROM app_settings WHERE id=1`)
}

// RecipesEnabled returns true when the Recipe/Formula module is turned on
// for this deployment. Reads the singleton app_settings row.
// A missing row (fresh DB) is treated as disabled — returns false, nil.
func (r *Repo) RecipesEnabled(ctx context.Context) (bool, error) {
	var enabled bool
	err := r.Pool.QueryRow(ctx,
		`SELECT COALESCE(recipes_enabled, false) FROM app_settings LIMIT 1`,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read recipes_enabled: %w", err)
	}
	return enabled, nil
}
