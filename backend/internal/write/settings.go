package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// validatePaymentMethods rejects shapes that would break the typed read path (and
// so sync pull on every tablet): wrong types (e.g. a non-bool isCash), empty ids
// and case-insensitive duplicate ids. The raw JSON is stored as sent.
func validatePaymentMethods(raw json.RawMessage) error {
	var methods []api.PaymentMethodConfig
	if err := json.Unmarshal(raw, &methods); err != nil {
		return fmt.Errorf("paymentMethods tidak valid: %w", err)
	}
	seen := make(map[string]bool, len(methods))
	for _, m := range methods {
		id := strings.ToLower(strings.TrimSpace(m.Id))
		if id == "" {
			return errors.New("paymentMethods: id metode pembayaran wajib diisi")
		}
		if seen[id] {
			return fmt.Errorf("paymentMethods: id ganda %q", m.Id)
		}
		seen[id] = true
	}
	return nil
}

func (r *Repo) UpdateAppSettings(ctx context.Context, raw json.RawMessage) error {
	var s struct {
		TaxEnabled           bool                  `json:"taxEnabled"`
		TaxRate              float64               `json:"taxRate"`
		RoundingEnabled      bool                  `json:"roundingEnabled"`
		RoundingType         string                `json:"roundingType"`
		RoundingAmount       *float64              `json:"roundingAmount"`
		RoundingDirection    *string               `json:"roundingDirection"`
		RoundingApplyToTax   *bool                 `json:"roundingApplyToTax"`
		AutoOpenShift        bool                  `json:"autoOpenShift"`
		AllowNegativeStock   bool                  `json:"allowNegativeStock"`
		PaymentMethods       json.RawMessage       `json:"paymentMethods"`
		Receipt              json.RawMessage       `json:"receipt"`
		ReceiveApproverRoles []string              `json:"receiveApproverRoles"`
		RecipesEnabled       *bool                 `json:"recipesEnabled"`
		Documents            *api.DocumentSettings `json:"documents"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if len(s.PaymentMethods) == 0 || strings.TrimSpace(string(s.PaymentMethods)) == "null" {
		s.PaymentMethods = json.RawMessage("[]")
	}
	if err := validatePaymentMethods(s.PaymentMethods); err != nil {
		return err
	}
	if len(s.Receipt) == 0 {
		s.Receipt = json.RawMessage("{}")
	}
	if s.ReceiveApproverRoles == nil {
		s.ReceiveApproverRoles = []string{}
	}

	return r.tx(ctx, "appSettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE app_settings SET tax_enabled=$1, tax_rate=$2,
			  rounding_enabled=$3, rounding_type=$4, rounding_amount=$5,
			  rounding_direction=$6, rounding_apply_to_tax=$7, auto_open_shift=$8,
			  payment_methods=$9, receipt=$10, receive_approver_roles=$11,
			  allow_negative_stock=$12 WHERE id=1`,
			s.TaxEnabled, s.TaxRate, s.RoundingEnabled, s.RoundingType,
			s.RoundingAmount, s.RoundingDirection, s.RoundingApplyToTax,
			s.AutoOpenShift, []byte(s.PaymentMethods), []byte(s.Receipt),
			s.ReceiveApproverRoles, s.AllowNegativeStock)
		if e != nil {
			return e
		}
		// Only write documents columns when the block is present in the request.
		// Absent documents block → leave existing DB values untouched.
		// Present but null/unspecified individual fields → set to SQL NULL (clear).
		if d := s.Documents; d != nil {
			var docLogoURL, docBrandName, docAddressLines, docPhone, docNPWP *string
			if v, err := d.LogoUrl.Get(); err == nil {
				docLogoURL = &v
			}
			if v, err := d.BrandName.Get(); err == nil {
				docBrandName = &v
			}
			if v, err := d.AddressLines.Get(); err == nil {
				docAddressLines = &v
			}
			if v, err := d.Phone.Get(); err == nil {
				docPhone = &v
			}
			if v, err := d.Npwp.Get(); err == nil {
				docNPWP = &v
			}
			if _, e := t.Exec(ctx, `
				UPDATE app_settings SET
				  documents_logo_url=$1, documents_brand_name=$2,
				  documents_address_lines=$3, documents_phone=$4,
				  documents_npwp=$5 WHERE id=1`,
				docLogoURL, docBrandName, docAddressLines, docPhone, docNPWP); e != nil {
				return fmt.Errorf("update documents: %w", e)
			}
		}
		if s.RecipesEnabled != nil {
			if _, e := t.Exec(ctx,
				`UPDATE app_settings SET recipes_enabled=$1 WHERE id=1`,
				*s.RecipesEnabled); e != nil {
				return fmt.Errorf("update recipes_enabled: %w", e)
			}
		}
		return e
	})
}

func (r *Repo) UpdateLoyaltySettings(ctx context.Context, raw json.RawMessage) error {
	var s struct {
		Enabled        bool    `json:"enabled"`
		TierEnabled    bool    `json:"tierEnabled"`
		PointsPerK     float64 `json:"pointsPerThousand"`
		RedemptionRate float64 `json:"redemptionRate"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	return r.tx(ctx, "loyaltySettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE loyalty_settings SET enabled=$1, tier_enabled=$2,
			  points_per_thousand=$3, redemption_rate=$4 WHERE id=1`,
			s.Enabled, s.TierEnabled, s.PointsPerK, s.RedemptionRate)
		return e
	})
}
