package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// RewardPreviewVariant is one sellable size of a reward product (price is the
// normal price, shown struck-through; the cashier gives it for Rp0).
type RewardPreviewVariant struct {
	Size  string  `json:"size"`
	Price float64 `json:"price"`
}

// RewardPreviewProduct is one eligible free product with its sizes.
type RewardPreviewProduct struct {
	ID       string                 `json:"id"`
	Name     string                 `json:"name"`
	Variants []RewardPreviewVariant `json:"variants"`
}

// RewardPreview is one matched product_reward condition + its pick menu.
type RewardPreview struct {
	ConditionID   string                 `json:"conditionId"`
	ConditionName string                 `json:"conditionName"`
	Products      []RewardPreviewProduct `json:"products"`
}

// PreviewRewards evaluates the active product_reward conditions for this cart +
// customer and returns the eligible free-item menus. Read-only, online-only,
// advisory: CreateOrder re-evaluates authoritatively at commit. total is the
// client-computed cart total (for the spending_threshold trigger).
func (s *OrderService) PreviewRewards(ctx context.Context, customerID string, items []OrderItem, total float64, clientCreated *time.Time) ([]RewardPreview, error) {
	if customerID == "" {
		return nil, nil
	}
	loyEnabled, pointsPerK, _, err := loadLoyalty(ctx, s.Pool)
	if err != nil {
		return nil, fmt.Errorf("load loyalty: %w", err)
	}
	if !loyEnabled {
		return nil, nil
	}
	var cust EvalCustomer
	if e := s.Pool.QueryRow(ctx,
		`SELECT birthday, anniversary, visit_count FROM customers WHERE id=$1`,
		customerID).Scan(&cust.Birthday, &cust.Anniversary, &cust.VisitCount); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("load customer: %w", e)
	}
	conds, err := loadActiveConditions(ctx, s.Pool)
	if err != nil {
		return nil, fmt.Errorf("preview load conditions: %w", err)
	}
	pidSet := make(map[string]bool, len(items)*2)
	for _, it := range items {
		if it.IsReward {
			continue
		}
		pidSet[it.ProductID] = true
		if it.VariantSize != "" {
			pidSet[variantKey(it.ProductID, it.VariantSize)] = true // variant-level trigger entries (SP-CRM-9b)
		}
	}
	saleTime := time.Now()
	if clientCreated != nil {
		saleTime = *clientCreated
	}
	rewards := ProductRewards(conds, EvalContext{
		Total:      total,
		BasePoints: int(total/1000) * int(pointsPerK),
		ProductIDs: pidSet,
		SaleDate:   saleTime.In(wib),
		Customer:   cust,
	})
	if len(rewards) == 0 {
		return nil, nil
	}
	out := make([]RewardPreview, 0, len(rewards))
	for _, r := range rewards {
		products, e := s.rewardProductMenu(ctx, r.RewardProductIDs)
		if e != nil {
			return nil, e
		}
		if len(products) == 0 {
			continue // every listed product is gone/unsellable — skip the reward
		}
		out = append(out, RewardPreview{
			ConditionID: r.ConditionID, ConditionName: r.Name, Products: products,
		})
	}
	return out, nil
}

// parseMenu splits SP-CRM-9b composite menu entries ("pid" or "pid|size") into
// the distinct product ids to query (entry order, deduped) and a per-product
// allowed-size set. A nil set means ALL sizes (whole-product entry; it wins over
// variant entries for the same product).
func parseMenu(entries []string) ([]string, map[string]map[string]bool) {
	allowed := make(map[string]map[string]bool, len(entries))
	var order []string
	for _, e := range entries {
		pid, size := e, ""
		if i := strings.IndexByte(e, '|'); i >= 0 {
			pid, size = e[:i], e[i+1:]
		}
		cur, seen := allowed[pid]
		if !seen {
			order = append(order, pid)
		}
		if size == "" {
			allowed[pid] = nil // whole product — all sizes
			continue
		}
		if seen && cur == nil {
			continue // a whole-product entry is already present; superset wins
		}
		if cur == nil {
			cur = make(map[string]bool)
			allowed[pid] = cur
		}
		cur[size] = true
	}
	return order, allowed
}

// rewardProductMenu resolves product ids → {name, sellable variants}. Drops
// products with no variants (nothing to give), inactive products, and missing products.
// ids may contain SP-CRM-9b composite entries ("pid" or "pid|size"); parseMenu
// extracts the base product ids for the DB query and the per-product size filter.
func (s *OrderService) rewardProductMenu(ctx context.Context, ids []string) ([]RewardPreviewProduct, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	productIDs, allowedSizes := parseMenu(ids)
	rows, err := s.Pool.Query(ctx, `
		SELECT p.id, p.name, v.size, v.price
		  FROM products p
		  JOIN product_variants v ON v.product_id = p.id
		 WHERE p.id = ANY($1) AND p.is_active = true
		 ORDER BY p.name, v.price`, productIDs)
	if err != nil {
		return nil, fmt.Errorf("load reward products: %w", err)
	}
	defer rows.Close()
	byID := make(map[string]*RewardPreviewProduct)
	var order []string
	for rows.Next() {
		var pid, name, size string
		var price float64
		if e := rows.Scan(&pid, &name, &size, &price); e != nil {
			return nil, fmt.Errorf("scan reward product: %w", e)
		}
		if sz := allowedSizes[pid]; sz != nil && !sz[size] {
			continue // variant-level entry: this size isn't on the menu (SP-CRM-9b)
		}
		p, ok := byID[pid]
		if !ok {
			p = &RewardPreviewProduct{ID: pid, Name: name}
			byID[pid] = p
			order = append(order, pid)
		}
		p.Variants = append(p.Variants, RewardPreviewVariant{Size: size, Price: price})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reward product rows: %w", err)
	}
	out := make([]RewardPreviewProduct, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}
