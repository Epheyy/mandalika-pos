package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

// rewardLineAllowed reports whether a reward line's chosen item is on the
// condition's menu: listed as the whole product ("pid") or the exact variant
// ("pid|size"). SP-CRM-9b composite entries.
func rewardLineAllowed(menu []string, productID, size string) bool {
	if contains(menu, productID) {
		return true
	}
	return size != "" && contains(menu, variantKey(productID, size))
}

// rewardCatalog is one reward product's catalog identity: server name + per-unit
// full (normal) price, looked up by (productId, variantSize). found=false means the
// variant is gone/inactive → the reward line is unfulfillable.
type rewardCatalog struct {
	name      string
	fullPrice float64
	found     bool
}

// loadRewardCatalog fetches the active product's name + variant price. A reward
// line whose variant no longer exists (deleted/inactive) is treated as invalid.
func loadRewardCatalog(ctx context.Context, tx pgx.Tx, productID, size string) (rewardCatalog, error) {
	var c rewardCatalog
	e := tx.QueryRow(ctx, `
		SELECT p.name, v.price
		  FROM products p
		  JOIN product_variants v ON v.product_id = p.id
		 WHERE p.id = $1 AND v.size = $2 AND p.is_active = true`,
		productID, size).Scan(&c.name, &c.fullPrice)
	if errors.Is(e, pgx.ErrNoRows) {
		return rewardCatalog{}, nil // unfulfillable, not a hard error
	}
	if e != nil {
		return rewardCatalog{}, fmt.Errorf("load reward catalog: %w", e)
	}
	c.found = true
	return c, nil
}

// resolveRewardLines validates each SP-Promo-3b buy_x_get_y reward line in in.Items
// against its promotion's get-set + earned quota, repricing valid lines to the
// SERVER net (never the client value) and emitting one grant row each. It mutates
// in.Items in place: valid reward lines get Price/Subtotal overwritten with the net;
// offline-invalid lines are removed entirely (not charged, not stocked, not granted).
// An ONLINE invalid line returns *ErrDiscountRejected{ViolationRewardInvalid} (→422).
// Returns grants (OrderID left blank for the caller to stamp) and a warn reason
// (non-empty only when an offline order dropped a line).
func (s *OrderService) resolveRewardLines(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) ([]write.RewardGrantRow, string, error) {
	// Fast exit: no reward lines reference a promo → nothing to do (common case).
	any := false
	for _, it := range in.Items {
		if it.IsReward && it.RewardPromotionID != "" {
			any = true
			break
		}
	}
	if !any {
		return nil, "", nil
	}

	// Paid (non-reward) lines drive the earned-quota math (hard contract: reward
	// lines must NOT count as buy units).
	var paid []LineItem
	for _, it := range in.Items {
		if it.IsReward {
			continue
		}
		paid = append(paid, LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal})
	}

	cfgCache := map[string]*BXGYConfig{} // promoID -> bxgyConfig (nil = absent/invalid promo)
	cfgLoaded := map[string]bool{}
	honored := map[string]int{} // promoID -> reward UNITS already honored this order

	bxgyFor := func(promoID string) (*BXGYConfig, error) {
		if cfgLoaded[promoID] {
			return cfgCache[promoID], nil
		}
		spec, _, _, _, found, err := s.loadPromoSpec(ctx, tx, promoID, PromoEvalContext{})
		if err != nil {
			return nil, err
		}
		var cfg *BXGYConfig
		if found && spec.Kind == DiscountBuyXGetY {
			cfg = spec.BXGY
		}
		cfgLoaded[promoID] = true
		cfgCache[promoID] = cfg
		return cfg, nil
	}

	var grants []write.RewardGrantRow
	kept := in.Items[:0] // reuse backing array; drops compact in place (offline only)
	var warns []PromoViolation

	for _, it := range in.Items {
		if !it.IsReward || it.RewardPromotionID == "" {
			kept = append(kept, it)
			continue
		}
		cfg, err := bxgyFor(it.RewardPromotionID)
		if err != nil {
			return nil, "", err
		}
		if cfg == nil {
			// Partition: a reward line whose promo isn't buy_x_get_y (e.g. an
			// SP-Promo-3b-bundle freed line) belongs to its own resolver
			// (resolveBundleLines) — pass it through untouched here instead of
			// treating it as an invalid bxgy reward. A genuinely missing promo
			// (found=false) or a bxgy promo with a nil config still falls through
			// to the invalid path below.
			spec, _, _, _, found, e := s.loadPromoSpec(ctx, tx, it.RewardPromotionID, PromoEvalContext{})
			if e != nil {
				return nil, "", e
			}
			if found && spec.Kind != DiscountBuyXGetY {
				kept = append(kept, it)
				continue
			}
		}
		if bxgyKeysOverlap(cfg) {
			if !in.Offline {
				return nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationRewardInvalid}}
			}
			// Already captured physical units: retain original price/quantity and
			// flag review. Do not fabricate a validated grant or drop the line.
			kept = append(kept, it)
			warns = append(warns, ViolationRewardInvalid)
			continue
		}
		cat, err := loadRewardCatalog(ctx, tx, it.ProductID, it.VariantSize)
		if err != nil {
			return nil, "", err
		}

		ok, net := false, 0.0
		if cat.found {
			ok, net = rewardLineEntitled(cfg, paid, honored[it.RewardPromotionID], it.ProductID, it.VariantSize, cat.fullPrice)
		}
		// Quantity-aware quota: a qty-N reward line needs N units of remaining quota.
		if ok && cfg != nil && honored[it.RewardPromotionID]+it.Quantity > bxgyRewardDue(cfg, paid) {
			ok = false
		}
		if !ok {
			if !in.Offline {
				return nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationRewardInvalid}}
			}
			// Offline: drop the line (not charged/stocked/granted) and flag the order.
			slog.Warn("dropping unfulfillable reward line (offline)",
				"promotion_id", it.RewardPromotionID, "product_id", it.ProductID,
				"variant_size", it.VariantSize, "quantity", it.Quantity)
			warns = append(warns, ViolationRewardInvalid)
			continue
		}

		honored[it.RewardPromotionID] += it.Quantity
		// Server-authoritative repricing: never trust the client reward price.
		it.Price = net
		it.Subtotal = math.Round(net * float64(it.Quantity))
		kept = append(kept, it)
		// Write one grant row per unit (qty-N reward line → N rows) so the audit
		// table is one-row-per-unit and downstream reporting can count simply.
		for range it.Quantity {
			grants = append(grants, write.RewardGrantRow{
				PromotionID: it.RewardPromotionID, ProductID: it.ProductID,
				ProductName: cat.name, VariantSize: it.VariantSize,
				FullPrice: cat.fullPrice, RewardPrice: net, RewardValue: cat.fullPrice - net,
			})
		}
	}
	in.Items = kept

	warn := ""
	if len(warns) > 0 {
		warn = JoinViolations(warns)
	}
	return grants, warn, nil
}

// resolveBundleLines validates each SP-Promo-3b-bundle freed line (IsReward with a
// bundle-type RewardPromotionID) against its promo's slots, repricing valid lines to
// the SERVER net (cheapest-first, bundleAllocate) and emitting one grant per unit.
// Mutates in.Items in place (freed lines' Price/Subtotal only — it NEVER adds or
// removes physical units, so stock conservation is preserved: the POS already reduced
// the paid line qty when it added the reward line, and the stock loop decrements each
// line once regardless of its price). Partitioned from resolveRewardLines by promo
// type (bundle vs buy_x_get_y). ONLINE invalid → *ErrDiscountRejected{ViolationBundleInvalid};
// OFFLINE invalid → KEEP the freed line at the client price (it is a physical unit the
// customer is taking) + warn (never drop). Returns grants (OrderID stamped by caller)
// and a warn reason (non-empty only for an offline order that kept an unvalidated line).
func (s *OrderService) resolveBundleLines(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) ([]write.RewardGrantRow, string, error) {
	// Discover the bundle promos referenced by reward lines (fast exit if none).
	bundleIDs := map[string]bool{}
	for _, it := range in.Items {
		if !it.IsReward || it.RewardPromotionID == "" || bundleIDs[it.RewardPromotionID] {
			continue
		}
		spec, _, _, _, found, err := s.loadPromoSpec(ctx, tx, it.RewardPromotionID, PromoEvalContext{})
		if err != nil {
			return nil, "", err
		}
		if found && spec.Kind == DiscountBundle {
			bundleIDs[it.RewardPromotionID] = true
		}
	}
	if len(bundleIDs) == 0 {
		return nil, "", nil
	}

	// Paid (non-reward) lines are shared across all bundle promos in this order.
	var paid []LineItem
	for _, it := range in.Items {
		if it.IsReward {
			continue
		}
		paid = append(paid, LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity})
	}

	var grants []write.RewardGrantRow
	var warns []PromoViolation

	for promoID := range bundleIDs {
		spec, _, _, _, _, err := s.loadPromoSpec(ctx, tx, promoID, PromoEvalContext{})
		if err != nil {
			return nil, "", err
		}
		cfg := spec.Bundle

		// Collect this promo's freed lines (index + catalog name/full price) and expand
		// to per-unit inputs for the pure helper.
		type freedLine struct {
			idx       int
			name      string
			fullPrice float64
			qty       int
		}
		var lines []freedLine
		var units []bundleFreedUnit
		valid := cfg != nil
		for i := range in.Items {
			it := &in.Items[i]
			if !it.IsReward || it.RewardPromotionID != promoID {
				continue
			}
			cat, err := loadRewardCatalog(ctx, tx, it.ProductID, it.VariantSize)
			if err != nil {
				return nil, "", err
			}
			if !cat.found {
				valid = false // unfulfillable variant → invalid bundle
			}
			lines = append(lines, freedLine{idx: i, name: cat.name, fullPrice: cat.fullPrice, qty: it.Quantity})
			for n := 0; n < it.Quantity; n++ {
				units = append(units, bundleFreedUnit{ProductID: it.ProductID, VariantSize: it.VariantSize, FullPrice: cat.fullPrice})
			}
		}

		var nets []float64
		if valid {
			var ok bool
			if nets, ok = bundleFreedNets(cfg, paid, units); !ok {
				valid = false
			}
		}

		if !valid {
			if !in.Offline {
				return nil, "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationBundleInvalid}}
			}
			// Offline: KEEP the freed lines as-rung (physical units the customer is
			// taking) and flag the order for admin reconciliation.
			slog.Warn("keeping unvalidated bundle reward line(s) (offline)", "promotion_id", promoID)
			warns = append(warns, ViolationBundleInvalid)
			continue
		}

		// Reprice each freed line to the SERVER net (Σ of its units' nets) and emit one
		// grant per unit. `nets` is aligned to `units` (qty-expanded, lines in order).
		u := 0
		for _, ln := range lines {
			it := &in.Items[ln.idx]
			var sub float64
			for k := 0; k < ln.qty; k++ {
				net := nets[u]
				u++
				sub += net
				grants = append(grants, write.RewardGrantRow{
					PromotionID: promoID, ProductID: it.ProductID,
					ProductName: ln.name, VariantSize: it.VariantSize,
					FullPrice: ln.fullPrice, RewardPrice: net, RewardValue: ln.fullPrice - net,
				})
			}
			it.Subtotal = math.Round(sub)
			if ln.qty > 0 {
				it.Price = math.Round(sub / float64(ln.qty))
			}
		}
	}

	warn := ""
	if len(warns) > 0 {
		warn = JoinViolations(warns)
	}
	return grants, warn, nil
}

// rewardLineEntitled reports whether a reward line (product/size at fullPrice) is
// allowed for this buy_x_get_y promo given the PAID lines and how many reward
// units of this promo were already honored, and returns the net price to charge.
func rewardLineEntitled(c *BXGYConfig, paid []LineItem, alreadyHonored int, productID, size string, fullPrice float64) (bool, float64) {
	if c == nil || len(c.GetProductIDs) == 0 {
		return false, 0
	}
	if !keyMatchesLine(c.GetProductIDs, productID, size) {
		return false, 0
	}
	if alreadyHonored >= bxgyRewardDue(c, paid) {
		return false, 0
	}
	return true, bxgyRewardNet(c, fullPrice)
}

// variantKey is the composite "pid|size" key shared by the loyalty trigger set,
// the reward-fulfillment grant, and rewardLineAllowed — they must agree, so the
// format lives in one place. SP-CRM-9b.
func variantKey(productID, size string) string {
	return productID + "|" + size
}
