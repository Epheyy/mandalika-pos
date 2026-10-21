package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// combinabilityViolation enforces the boolean gate: more than one discount may
// only coexist if EVERY one is combinable. A single discount never gates.
func combinabilityViolation(combinable []bool) *PromoViolation {
	if len(combinable) <= 1 {
		return nil
	}
	for _, c := range combinable {
		if !c {
			v := ViolationNotCombinable
			return &v
		}
	}
	return nil
}

// dedupeNonEmpty returns a new slice with empty strings removed and duplicate
// strings eliminated (first occurrence wins, order preserved). Returns nil when
// the input is nil or all elements are empty.
func dedupeNonEmpty(ss []string) []string {
	if len(ss) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(ss))
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// combinedViolations returns code-gate + linked-promotion violations as a fresh
// slice (Model A intersection: a linked code passes only if BOTH the code's gates
// and the promotion's rules pass). Does not mutate either argument.
func combinedViolations(code, promo []PromoViolation) []PromoViolation {
	out := make([]PromoViolation, 0, len(code)+len(promo))
	out = append(out, code...)
	out = append(out, promo...)
	return out
}

// parseTieredConfig unmarshals the tiered_config jsonb. nil/empty -> (nil, nil).
func parseTieredConfig(raw []byte) (*TieredConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c TieredConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse tiered_config: %w", err)
	}
	return &c, nil
}

// parseBXGYConfig unmarshals the bxgy_config jsonb. nil/empty -> (nil, nil).
func parseBXGYConfig(raw []byte) (*BXGYConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c BXGYConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse bxgy_config: %w", err)
	}
	return &c, nil
}

// parseBundleConfig unmarshals the bundle_config jsonb. nil/empty -> (nil, nil).
func parseBundleConfig(raw []byte) (*BundleConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var c BundleConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse bundle_config: %w", err)
	}
	return &c, nil
}

// loadPromoSpec loads an ACTIVE promotion by id, builds its PromoSpec, and returns
// its combinable + code_only flags and validation violations. found=false on
// ErrNoRows (caller decides reject-vs-flag by origin).
func (s *OrderService) loadPromoSpec(ctx context.Context, tx pgx.Tx, promoID string, ec PromoEvalContext) (spec PromoSpec, combinable, codeOnly bool, vio []PromoViolation, found bool, err error) {
	var kind string
	var value float64
	var ids []string
	var row PromoRow
	var bxgyRaw []byte
	var tieredRaw []byte
	var bundleRaw []byte
	e := tx.QueryRow(ctx,
		`SELECT type, value,
		   COALESCE(applicable_product_ids,'[]'::jsonb),
		   start_date, end_date, min_purchase,
		   COALESCE(active_from_hour,''), COALESCE(active_to_hour,''),
		   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb),
		   COALESCE(combinable,false), COALESCE(code_only,false), bxgy_config, tiered_config,
		   bundle_config
		   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
		Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
			&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs,
			&row.Combinable, &codeOnly, &bxgyRaw, &tieredRaw, &bundleRaw)
	if errors.Is(e, pgx.ErrNoRows) {
		return PromoSpec{}, false, false, nil, false, nil
	}
	if e != nil {
		return PromoSpec{}, false, false, nil, false, fmt.Errorf("load promotion: %w", e)
	}
	spec = PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
	if spec.Kind == DiscountBuyXGetY {
		cfg, perr := parseBXGYConfig(bxgyRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.BXGY = cfg
	}
	if spec.Kind == DiscountTiered {
		cfg, perr := parseTieredConfig(tieredRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.Tiered = cfg
	}
	if spec.Kind == DiscountBundle {
		cfg, perr := parseBundleConfig(bundleRaw)
		if perr != nil {
			return PromoSpec{}, false, false, nil, false, perr
		}
		spec.Bundle = cfg
	}
	vio = ValidatePromo(row, ec)
	if spec.Kind == DiscountBundle && bundleKeysOverlap(spec.Bundle) {
		vio = append(vio, ViolationBundleInvalid)
	}
	if spec.Kind == DiscountBuyXGetY && bxgyKeysOverlap(spec.BXGY) {
		vio = append(vio, ViolationRewardInvalid)
	}
	return spec, row.Combinable, codeOnly, vio, true, nil
}

// resolvePromos turns the applied promotion ids + discount codes into authoritative
// PromoSpecs, validating each stored gating rule (SP-Promo-1) AND the cross-discount
// combinability gate (SP-Promo-3a). Returns the applied discount_codes row ids (for
// usage++), the RESOLVED code strings that parallel codeIDs (for persisting to
// applied_discount_codes — only codes that successfully loaded), a non-empty
// warnReason when an OFFLINE order applied invalid/conflicting discounts (recorded +
// flagged), and *ErrDiscountRejected for an ONLINE conflict (caller -> HTTP 422).
//
// SP-Promo-3c (Model A): when a discount code has a non-null promotion_id, the LINKED
// PROMOTION supplies all discount mechanics; the code acts as a key — both the code's
// gates (ValidateCode) AND the promotion's rules (ValidatePromo) must pass (intersection).
// A code_only promotion is blocked on the direct promoIDs path and only reachable via a
// linked code. Deduplication prevents the same promotion from being applied twice across
// the direct and linked paths.
func (s *OrderService) resolvePromos(ctx context.Context, tx pgx.Tx, promoIDs, codes []string, ec PromoEvalContext, offline bool) ([]PromoSpec, []string /*codeIDs*/, []string /*appliedCodes*/, string, error) {
	// I1: dedupe both lists before processing — a duplicate code would double-increment
	// usage_count and falsely trip the combinability gate (two entries → len>1).
	promoIDs = dedupeNonEmpty(promoIDs)
	codes = dedupeNonEmpty(codes)

	var specs []PromoSpec
	var codeIDs []string
	var appliedCodes []string
	var combinable []bool
	var violations []PromoViolation
	seen := map[string]bool{} // resolved promotion ids already applied (cross-path dedupe)

	reject := func(v []PromoViolation) ([]PromoSpec, []string, []string, string, error) {
		return nil, nil, nil, "", &ErrDiscountRejected{Violations: v}
	}

	// ── direct promotions ────────────────────────────────────
	for _, promoID := range promoIDs {
		if promoID == "" {
			continue
		}
		spec, comb, codeOnly, vio, found, err := s.loadPromoSpec(ctx, tx, promoID, ec)
		if err != nil {
			return nil, nil, nil, "", err
		}
		if !found {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		// code_only promotions can't be applied directly — only via a linked code.
		if codeOnly {
			if !offline {
				return reject([]PromoViolation{ViolationCodeOnly})
			}
			violations = append(violations, ViolationCodeOnly)
			continue
		}
		if len(vio) > 0 {
			if !offline {
				return reject(vio)
			}
			violations = append(violations, vio...)
		}
		seen[promoID] = true
		specs = append(specs, spec)
		combinable = append(combinable, comb)
	}

	// ── discount codes ───────────────────────────────────────
	// A42: lock every applied code up front in sorted order; the per-code FOR UPDATE
	// below (request order) then only re-acquires locks this tx already holds.
	if _, err := lockCodes(ctx, tx, codes, true); err != nil {
		return nil, nil, nil, "", err
	}
	for _, code := range codes {
		if code == "" {
			continue
		}
		var id, kind string
		var value float64
		var promotionID *string
		var row CodeRow
		// FOR UPDATE: hold the row lock from validation through usage_count++ later
		// in this same tx — makes the usage_limit check race-safe.
		err := tx.QueryRow(ctx,
			`SELECT id, promotion_id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable, per_customer_limit, customer_id
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &promotionID, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable, &row.PerCustomerLimit, &row.CustomerID)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return reject([]PromoViolation{ViolationNotFound})
			}
			violations = append(violations, ViolationNotFound)
			continue
		}
		if err != nil {
			return nil, nil, nil, "", fmt.Errorf("load discount code: %w", err)
		}

		codeVio := ValidateCode(row, ec)

		// SP-Code-3: server-only per-customer cap. (requires-customer already handled
		// by ValidateCode above.) Counted under the FOR UPDATE code-row lock held from
		// the SELECT above through usage_count++ later in this tx, so it's race-safe.
		if row.PerCustomerLimit != nil && ec.HasCustomer {
			keeper, kerr := resolveMergedCustomer(ctx, tx, ec.CustomerID)
			if kerr != nil {
				keeper = ec.CustomerID // fall back to the raw id
			}
			var used int
			if e := tx.QueryRow(ctx,
				`SELECT count(*) FROM orders
				   WHERE customer_id = $1 AND status = 'completed'
				     AND jsonb_exists(COALESCE(applied_discount_codes, '[]'::jsonb), $2)`,
				keeper, code).Scan(&used); e != nil {
				return nil, nil, nil, "", fmt.Errorf("count per-customer redemptions: %w", e)
			}
			if used >= *row.PerCustomerLimit {
				codeVio = append(codeVio, ViolationPerCustomerCapReached)
			}
		}

		// ── LINKED CODE (Model A: code is a key) ──────────────
		if promotionID != nil && *promotionID != "" {
			if seen[*promotionID] {
				slog.Warn("linked promotion already applied; skipping redundant code",
					"code", code, "promotionId", *promotionID)
				continue
			}
			pspec, pcomb, _, pvio, found, lerr := s.loadPromoSpec(ctx, tx, *promotionID, ec)
			if lerr != nil {
				return nil, nil, nil, "", lerr
			}
			if !found {
				if !offline {
					return reject([]PromoViolation{ViolationNotFound})
				}
				violations = append(violations, ViolationNotFound)
				continue
			}
			if all := combinedViolations(codeVio, pvio); len(all) > 0 {
				if !offline {
					return reject(all)
				}
				violations = append(violations, all...)
			}
			seen[*promotionID] = true
			specs = append(specs, pspec)
			combinable = append(combinable, pcomb)
			codeIDs = append(codeIDs, id)
			appliedCodes = append(appliedCodes, code)
			continue
		}

		// ── UNLINKED CODE (pre-3c behavior, byte-identical) ───
		if len(codeVio) > 0 {
			if !offline {
				return reject(codeVio)
			}
			violations = append(violations, codeVio...)
		}
		spec := PromoSpec{Kind: DiscountKind(kind), Value: value}
		specs = append(specs, spec)
		// C1: append id and code string in lockstep so appliedCodes mirrors codeIDs.
		// Only codes that successfully loaded (no pgx.ErrNoRows continue above) reach here.
		codeIDs = append(codeIDs, id)
		appliedCodes = append(appliedCodes, code)
		combinable = append(combinable, row.Combinable)
	}

	if v := combinabilityViolation(combinable); v != nil {
		if !offline {
			return reject([]PromoViolation{*v})
		}
		violations = append(violations, *v)
	}

	warn := ""
	if len(violations) > 0 {
		warn = JoinViolations(violations)
	}
	return specs, codeIDs, appliedCodes, warn, nil
}
