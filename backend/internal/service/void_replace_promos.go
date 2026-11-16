package service

// A Backoffice replacement never changes items, only payment lines and the customer, so it must
// price like the original did. Orders do not store which promotions applied, so they are recovered
// from what the sale did leave behind (see recoverPromotions and markRewardLines) and then priced
// again by the normal sale path at the ORIGINAL sale's time.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// manualDiscountLabel is the breakdown label the POS gives the cashier's manual discount.
const manualDiscountLabel = "Diskon Manual"

// warnPromoNotReproduced is the discount_warning_reason of a replacement whose original promotions
// (or some of them) could not be reproduced exactly, so a reviewer sees it next to the correction.
const warnPromoNotReproduced = "promo_not_reproduced"

// ErrVoidReplacementPromoChanged refuses a Backoffice replacement whose lines the sale path would
// not keep (a reward line the promotion no longer entitles): a dropped line would leave stock out
// of step with the goods the customer actually took.
var ErrVoidReplacementPromoChanged = apperr.New(apperr.Conflict,
	"Promo pada transaksi ini sudah berubah sehingga item pengganti tidak sama dengan aslinya. Buat penggantinya di POS.")

// rewardGrantUnits is the promo_reward_grants rows of one order, per promotion, product and size.
type rewardGrantUnits struct {
	PromotionID, ProductID, VariantSize string
	Units                               int
}

// markRewardLines flags, in a copy of items, the lines that carried a reward grant (a BXGY free or
// discounted unit, a bundle-freed unit) so the sale path re-validates and re-grants them. groups
// is the stored refund_group per line. A grant's lines are the ones in that promotion's group
// ("bxgy:<promo>:n" / "bundle:<promo>:n") for the same product and size, cheapest first (the
// reward is priced below its paid anchors) until the grant's units are covered exactly. A grant
// that cannot be covered exactly is returned in unrecovered and its lines stay plain (their stored
// prices still count, but no grant row or reward group is written for them).
func markRewardLines(items []OrderItem, groups []string, grants []rewardGrantUnits) ([]OrderItem, []rewardGrantUnits) {
	out := append([]OrderItem(nil), items...)
	var unrecovered []rewardGrantUnits
	for _, g := range grants {
		var cand []int
		for i, it := range out {
			grp := groups[i]
			inGroup := strings.HasPrefix(grp, "bxgy:"+g.PromotionID+":") || strings.HasPrefix(grp, "bundle:"+g.PromotionID+":")
			if inGroup && !it.IsReward && it.ProductID == g.ProductID && it.VariantSize == g.VariantSize {
				cand = append(cand, i)
			}
		}
		sort.SliceStable(cand, func(a, b int) bool { return out[cand[a]].Price < out[cand[b]].Price })
		remaining := g.Units
		var chosen []int
		for _, i := range cand {
			if out[i].Quantity <= remaining {
				chosen = append(chosen, i)
				remaining -= out[i].Quantity
			}
		}
		if remaining != 0 {
			unrecovered = append(unrecovered, g)
			continue
		}
		for _, i := range chosen {
			out[i].IsReward, out[i].RewardPromotionID = true, g.PromotionID
		}
	}
	return out, unrecovered
}

// breakdownLabels returns the labels of the sale's discount components that took money off, minus
// the manual discount and the discount codes (those are re-applied from their own columns).
func breakdownLabels(breakdown []byte, codes []string) []string {
	var parts []struct {
		Label  string  `json:"label"`
		Amount float64 `json:"amount"`
	}
	if len(breakdown) == 0 || json.Unmarshal(breakdown, &parts) != nil {
		return nil
	}
	isCode := map[string]bool{}
	for _, c := range codes {
		isCode[c] = true
	}
	var out []string
	for _, p := range parts {
		if p.Amount > 0 && p.Label != "" && p.Label != manualDiscountLabel && !isCode[p.Label] {
			out = append(out, p.Label)
		}
	}
	return out
}

// loadRewardGrantUnits reads the order's reward grants, one row per unit, grouped.
func loadRewardGrantUnits(ctx context.Context, tx pgx.Tx, orderID string) ([]rewardGrantUnits, error) {
	rows, err := tx.Query(ctx,
		`SELECT promotion_id::text, product_id::text, variant_size, count(*)::int
		   FROM promo_reward_grants WHERE order_id=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`, orderID)
	if err != nil {
		return nil, fmt.Errorf("load reward grants: %w", err)
	}
	defer rows.Close()
	var out []rewardGrantUnits
	for rows.Next() {
		var g rewardGrantUnits
		if err := rows.Scan(&g.PromotionID, &g.ProductID, &g.VariantSize, &g.Units); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// recoverPromotionIDs names the promotions the original sale applied: the promotions behind its
// reward grants, plus every discount component (by label) that matches exactly one active,
// non-code-only promotion of that name that already existed when the sale was made. A label that matches none or several cannot be told apart, so
// that promotion is not re-applied and its value lands in the replacement's "Penyesuaian koreksi"
// (the total is forced to the original's). Those labels are returned for the log.
func recoverPromotionIDs(ctx context.Context, tx pgx.Tx, soldAt time.Time, rewardPromoIDs []string, breakdown []byte, codes []string) (ids, unmatched []string, err error) {
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	named := map[string]bool{} // names of the promotions already recovered through a grant
	for _, id := range rewardPromoIDs {
		add(id)
		var name string
		if e := tx.QueryRow(ctx, `SELECT name FROM promotions WHERE id=$1`, id).Scan(&name); e == nil {
			named[name] = true
		} else if e != pgx.ErrNoRows {
			return nil, nil, e
		}
	}
	for _, label := range breakdownLabels(breakdown, codes) {
		if named[label] {
			continue
		}
		rows, e := tx.Query(ctx,
			`SELECT id::text FROM promotions WHERE name=$1 AND is_active=true AND NOT COALESCE(code_only,false) AND created_at <= $2`, label, soldAt)
		if e != nil {
			return nil, nil, fmt.Errorf("match promotion by name: %w", e)
		}
		var match []string
		for rows.Next() {
			var id string
			if e := rows.Scan(&id); e != nil {
				rows.Close()
				return nil, nil, e
			}
			match = append(match, id)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return nil, nil, e
		}
		if len(match) == 1 {
			add(match[0])
		} else {
			unmatched = append(unmatched, label)
		}
	}
	return ids, unmatched, nil
}

// rewardPromosStillHold returns the promotions whose flagged reward lines the sale path would now
// DROP (resolveRewardLines / resolveBundleLines): the promotion is inactive or no longer that kind,
// the reward product or size is inactive, or the quota no longer holds under today's config. It
// mirrors those resolvers' entitlement checks without writing anything.
func rewardPromosStillHold(ctx context.Context, tx pgx.Tx, items []OrderItem) (map[string]bool, error) {
	var paid []LineItem
	byPromo := map[string][]OrderItem{}
	var order []string
	for _, it := range items {
		if it.IsReward && it.RewardPromotionID != "" {
			if _, seen := byPromo[it.RewardPromotionID]; !seen {
				order = append(order, it.RewardPromotionID)
			}
			byPromo[it.RewardPromotionID] = append(byPromo[it.RewardPromotionID], it)
			continue
		}
		paid = append(paid, LineItem{ProductID: it.ProductID, VariantSize: it.VariantSize, Price: it.Price, Quantity: it.Quantity, Subtotal: it.Subtotal})
	}
	broken := map[string]bool{}
	for _, promo := range order {
		ok, err := promoRewardsHold(ctx, tx, promo, byPromo[promo], paid)
		if err != nil {
			return nil, err
		}
		if !ok {
			broken[promo] = true
		}
	}
	return broken, nil
}

// promoRewardsHold reports whether every reward line of one promotion would be kept.
func promoRewardsHold(ctx context.Context, tx pgx.Tx, promo string, lines []OrderItem, paid []LineItem) (bool, error) {
	spec, _, _, _, found, err := (*OrderService)(nil).loadPromoSpec(ctx, tx, promo, PromoEvalContext{})
	if err != nil || !found {
		return false, err
	}
	if spec.Kind != DiscountBuyXGetY && spec.Kind != DiscountBundle {
		return false, nil
	}
	honored := 0
	var units []bundleFreedUnit
	for _, it := range lines {
		cat, err := loadRewardCatalog(ctx, tx, it.ProductID, it.VariantSize)
		if err != nil || !cat.found {
			return false, err
		}
		if spec.Kind == DiscountBundle {
			for n := 0; n < it.Quantity; n++ {
				units = append(units, bundleFreedUnit{ProductID: it.ProductID, VariantSize: it.VariantSize, FullPrice: cat.fullPrice})
			}
			continue
		}
		cfg := spec.BXGY
		if cfg == nil || bxgyKeysOverlap(cfg) {
			return false, nil
		}
		entitled, _ := rewardLineEntitled(cfg, paid, honored, it.ProductID, it.VariantSize, cat.fullPrice)
		if !entitled || honored+it.Quantity > bxgyRewardDue(cfg, paid) {
			return false, nil
		}
		honored += it.Quantity
	}
	if spec.Kind == DiscountBundle {
		_, ok := bundleFreedNets(spec.Bundle, paid, units)
		return ok, nil
	}
	return true, nil
}

// applyRecoveredPromotions fills the replacement's promotion ids and reward flags from the stored
// order. groups is the stored refund_group per line of in.Items. A reward line the sale path would
// drop today stays a plain line at its stored price (the unit was handed over; the total is forced
// to the original's), and the replacement is flagged promo_not_reproduced, as is any promotion that
// cannot be matched.
func applyRecoveredPromotions(ctx context.Context, tx pgx.Tx, orderID string, in CreateOrderInput, groups []string) (CreateOrderInput, error) {
	grants, err := loadRewardGrantUnits(ctx, tx, orderID)
	if err != nil {
		return in, err
	}
	items, unrecovered := markRewardLines(in.Items, groups, grants)
	broken, err := rewardPromosStillHold(ctx, tx, items)
	if err != nil {
		return in, err
	}
	if len(broken) > 0 {
		items = append([]OrderItem(nil), items...)
		for i := range items {
			if broken[items[i].RewardPromotionID] {
				items[i].IsReward, items[i].RewardPromotionID = false, ""
			}
		}
	}
	var rewardPromos []string
	for _, g := range grants {
		if !broken[g.PromotionID] {
			rewardPromos = append(rewardPromos, g.PromotionID)
		}
	}
	codes := in.DiscountCodes
	if len(codes) == 0 && in.DiscountCode != "" {
		codes = []string{in.DiscountCode}
	}
	soldAt := time.Now()
	if in.EvalTime != nil {
		soldAt = *in.EvalTime
	}
	ids, unmatched, err := recoverPromotionIDs(ctx, tx, soldAt, rewardPromos, in.DiscountBreakdown, codes)
	if err != nil {
		return in, err
	}
	if len(unrecovered) > 0 || len(unmatched) > 0 || len(broken) > 0 {
		slog.Warn("void replacement: some promotions of the original could not be reproduced exactly; the gap goes to the correction",
			"order_id", orderID, "reward_grants_unmatched", len(unrecovered), "reward_promotions_broken", len(broken), "promotion_labels_unmatched", unmatched)
		in.warnReason = warnPromoNotReproduced
	}
	in.Items, in.PromotionIDs = items, ids
	return in, nil
}

// checkReplacementKeepsItems refuses (and so rolls back the whole void) when the replacement sale
// does not hold exactly the original's lines (product, size, quantity). The sale path drops an
// offline reward line it no longer entitles; the physical unit was still handed over, so keeping
// that sale would put stock out of step.
func checkReplacementKeepsItems(ctx context.Context, tx pgx.Tx, origID, replID string) error {
	var diff int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM (
		  (SELECT product_id, variant_size, quantity FROM order_items WHERE order_id=$1
		   EXCEPT ALL SELECT product_id, variant_size, quantity FROM order_items WHERE order_id=$2)
		  UNION ALL
		  (SELECT product_id, variant_size, quantity FROM order_items WHERE order_id=$2
		   EXCEPT ALL SELECT product_id, variant_size, quantity FROM order_items WHERE order_id=$1)) d`,
		origID, replID).Scan(&diff)
	if err != nil {
		return fmt.Errorf("compare replacement lines: %w", err)
	}
	if diff > 0 {
		return ErrVoidReplacementPromoChanged
	}
	return nil
}
