package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// reservedSplitMethodID is the orders.payment_method sentinel of a split-payment sale; it is
// never a real method (the order_tenders CHECK backs this).
const reservedSplitMethodID = "split"

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
		if id == reservedSplitMethodID {
			return fmt.Errorf("paymentMethods: id %q dicadangkan untuk pembayaran split dan tidak boleh dipakai sebagai metode", m.Id)
		}
		seen[id] = true
	}
	return nil
}

func (r *Repo) UpdateAppSettings(ctx context.Context, raw json.RawMessage) error {
	return r.UpdateAppSettingsBy(ctx, "", raw)
}

// UpdateAppSettingsBy is UpdateAppSettings recording actor ("" allowed) on the history row of an
// approval-switch change.
func (r *Repo) UpdateAppSettingsBy(ctx context.Context, actor string, raw json.RawMessage) error {
	var s struct {
		TaxEnabled           bool            `json:"taxEnabled"`
		TaxRate              float64         `json:"taxRate"`
		RoundingEnabled      bool            `json:"roundingEnabled"`
		RoundingType         string          `json:"roundingType"`
		RoundingAmount       *float64        `json:"roundingAmount"`
		RoundingDirection    *string         `json:"roundingDirection"`
		RoundingApplyToTax   *bool           `json:"roundingApplyToTax"`
		AutoOpenShift        bool            `json:"autoOpenShift"`
		AllowNegativeStock   bool            `json:"allowNegativeStock"`
		PaymentMethods       json.RawMessage `json:"paymentMethods"`
		Receipt              json.RawMessage `json:"receipt"`
		ReceiveApproverRoles []string        `json:"receiveApproverRoles"`
		RecipesEnabled       *bool           `json:"recipesEnabled"`
		// InventoryApprovalRequired: absent leaves the stored value untouched (older clients
		// that do not know the field must not switch the approval flow off).
		InventoryApprovalRequired *bool                 `json:"inventoryApprovalRequired"`
		Documents                 *api.DocumentSettings `json:"documents"`
		// SplitTenderEnabled: absent leaves the stored value untouched (a form that does not
		// know the key must not switch split payment off).
		SplitTenderEnabled *bool `json:"splitTenderEnabled"`
		// VoidWindowDays: absent leaves the stored value untouched; outside 1-30 is refused.
		VoidWindowDays *int `json:"voidWindowDays"`
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
	if err := validateReceiptSettings(s.Receipt); err != nil {
		return err
	}
	if s.ReceiveApproverRoles == nil {
		s.ReceiveApproverRoles = []string{}
	}
	if s.VoidWindowDays != nil && (*s.VoidWindowDays < 1 || *s.VoidWindowDays > 30) {
		return errors.New("Batas waktu pembatalan harus 1–30 hari.")
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
		if s.SplitTenderEnabled != nil {
			// The first switch-on stamps split_tender_enabled_at; switching off never clears it.
			if _, e := t.Exec(ctx, `
				UPDATE app_settings SET split_tender_enabled=$1,
				  split_tender_enabled_at = CASE WHEN $1 THEN COALESCE(split_tender_enabled_at, now())
				                                 ELSE split_tender_enabled_at END
				WHERE id=1`, *s.SplitTenderEnabled); e != nil {
				return fmt.Errorf("update split_tender_enabled: %w", e)
			}
		}
		if s.VoidWindowDays != nil {
			if _, e := t.Exec(ctx, `UPDATE app_settings SET void_window_days=$1 WHERE id=1`, *s.VoidWindowDays); e != nil {
				return fmt.Errorf("update void_window_days: %w", e)
			}
		}
		if s.InventoryApprovalRequired != nil {
			if e := setApprovalSwitch(ctx, t, actor, *s.InventoryApprovalRequired); e != nil {
				return fmt.Errorf("update inventory_approval_required: %w", e)
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
	// Rates only matter while points are on; a switched-off save must not fail on a value
	// an earlier release stored (the form hides the fields then).
	if s.Enabled {
		if err := validateLoyaltyRates(s.PointsPerK, s.RedemptionRate); err != nil {
			return err
		}
	}
	return r.tx(ctx, "loyaltySettings", func(t pgx.Tx) error {
		_, e := t.Exec(ctx, `
			UPDATE loyalty_settings SET enabled=$1, tier_enabled=$2,
			  points_per_thousand=$3, redemption_rate=$4 WHERE id=1`,
			s.Enabled, s.TierEnabled, s.PointsPerK, s.RedemptionRate)
		return e
	})
}

// Loyalty rate bounds: both rates divide or multiply money, so zero, negative and
// non-finite values are refused; the ceiling only catches typos.
const (
	MaxPointsPerThousand = 1000
	MaxRedemptionRate    = 100000
	MinReceiptCopies     = 1
	MaxReceiptCopies     = 5 // the printer clamps to the same range (packages/printer/src/print.ts)
)

func validateLoyaltyRates(pointsPerK, redemptionRate float64) error {
	if math.IsNaN(pointsPerK) || math.IsInf(pointsPerK, 0) || pointsPerK <= 0 || pointsPerK > MaxPointsPerThousand {
		return fmt.Errorf("poin per Rp 1.000 harus lebih dari 0 dan paling banyak %d", MaxPointsPerThousand)
	}
	if math.IsNaN(redemptionRate) || math.IsInf(redemptionRate, 0) || redemptionRate <= 0 || redemptionRate > MaxRedemptionRate {
		return fmt.Errorf("poin untuk Rp 1.000 diskon harus lebih dari 0 dan paling banyak %d", MaxRedemptionRate)
	}
	return nil
}

// validateReceiptSettings checks the one numeric receipt field the server can trust:
// copies, a whole number 1-5 when present (absent keeps the printer default of 1).
func validateReceiptSettings(raw json.RawMessage) error {
	var rc struct {
		Copies *float64 `json:"copies"`
	}
	if err := json.Unmarshal(raw, &rc); err != nil {
		return fmt.Errorf("receipt tidak valid: %w", err)
	}
	if rc.Copies == nil {
		return nil
	}
	n := *rc.Copies
	if n != math.Trunc(n) || n < MinReceiptCopies || n > MaxReceiptCopies {
		return fmt.Errorf("jumlah salinan struk harus bilangan bulat %d-%d", MinReceiptCopies, MaxReceiptCopies)
	}
	return nil
}
