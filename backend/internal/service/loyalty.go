package service

import (
	"math"
	"strconv"
	"time"
)

// LoyaltyCondition is the order-time view of a loyalty_conditions row, scanned by
// loadActiveConditions (order.go). Pure Go — no DB types — so the engine is testable.
type LoyaltyCondition struct {
	ID, Name, Type, Trigger, RewardType string
	RewardValue                         float64
	RewardProductIDs                    []string
	CampaignStartDate                   *time.Time // date-only; nil for always_on
	CampaignEndDate                     *time.Time
	ActiveDays                          []int // weekday indices, Sunday=0 (matches time.Weekday + JS getDay)
	ApplicableProductIDs                []string
	MinimumSpend                        *float64
	IsActive                            bool
}

// EvalCustomer is the loyalty-relevant slice of the order's customer (loaded under
// the FOR UPDATE row lock in CreateOrder).
type EvalCustomer struct {
	Birthday    *time.Time
	Anniversary *time.Time
	VisitCount  int
}

// EvalContext is everything the engine needs to decide matches for one order.
type EvalContext struct {
	Total      float64         // res.Total (pre-redemption)
	BasePoints int             // res.EarnedPoints — flat base, used for multiply attribution
	ProductIDs map[string]bool // set of order item product IDs
	SaleDate   time.Time       // already converted to WIB by the caller
	Customer   EvalCustomer
}

// AppliedCondition records one matched condition for the audit table.
type AppliedCondition struct {
	ConditionID, Name, Trigger, RewardType string
	RewardValue                            float64
	RewardProductIDs                       []string
	PointsContributed                      int // reporting attribution (0 for product_reward / non-winning multiply)
}

// LoyaltyOutcome is the engine result. FinalEarned(base) computes the order's points.
type LoyaltyOutcome struct {
	BestMultiplier float64
	FlatBonus      int
	Applied        []AppliedCondition
}

// FinalEarned folds the outcome over a base: round(base × bestMultiplier) + flatBonus.
func (o LoyaltyOutcome) FinalEarned(base int) int {
	return int(math.Round(float64(base)*o.BestMultiplier)) + o.FlatBonus
}

func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func mmddEqual(a, b time.Time) bool {
	return a.Month() == b.Month() && a.Day() == b.Day()
}

// matches reports whether one condition fires for this order.
func (c LoyaltyCondition) matches(ctx EvalContext) bool {
	if !c.IsActive {
		return false
	}
	// Date window for campaigns (inclusive, date-only). always_on ignores dates.
	if c.Type == "campaign" {
		if c.CampaignStartDate == nil || c.CampaignEndDate == nil {
			return false
		}
		d := dateOnly(ctx.SaleDate)
		if d.Before(dateOnly(*c.CampaignStartDate)) || d.After(dateOnly(*c.CampaignEndDate)) {
			return false
		}
	}
	switch c.Trigger {
	case "first_registration":
		return ctx.Customer.VisitCount == 0
	case "birthday":
		return ctx.Customer.Birthday != nil && mmddEqual(*ctx.Customer.Birthday, ctx.SaleDate)
	case "anniversary":
		return ctx.Customer.Anniversary != nil && mmddEqual(*ctx.Customer.Anniversary, ctx.SaleDate)
	case "double_date":
		return ctx.SaleDate.Day() == int(ctx.SaleDate.Month())
	case "member_day":
		wd := int(ctx.SaleDate.Weekday())
		for _, d := range c.ActiveDays {
			if d == wd {
				return true
			}
		}
		return false
	case "product_purchase":
		if len(c.ApplicableProductIDs) == 0 {
			return false
		}
		for _, pid := range c.ApplicableProductIDs {
			if ctx.ProductIDs[pid] {
				return true
			}
		}
		return false
	case "spending_threshold":
		return c.MinimumSpend != nil && ctx.Total >= *c.MinimumSpend
	}
	return false
}

// EvaluateLoyalty folds all matching conditions into a multiplier + flat bonus +
// applied list. conds is expected ordered (created_at, id) so multiply-tie
// attribution is deterministic. Conditions with reward_value <= 0 are ignored.
func EvaluateLoyalty(conds []LoyaltyCondition, ctx EvalContext) LoyaltyOutcome {
	out := LoyaltyOutcome{BestMultiplier: 1.0}

	// First pass: find the single highest positive multiplier among matches. On a tie
	// the first in input order (created_at, id) wins → deterministic across replays.
	// A deliberate fractional multiplier (0 < v < 1) is respected if it's the only one.
	bestIdx := -1
	for i, c := range conds {
		if c.RewardType != "multiply_points" || c.RewardValue <= 0 || !c.matches(ctx) {
			continue
		}
		if bestIdx == -1 || c.RewardValue > conds[bestIdx].RewardValue {
			bestIdx = i
		}
	}
	if bestIdx != -1 {
		out.BestMultiplier = conds[bestIdx].RewardValue
	}
	winnerDelta := int(math.Round(float64(ctx.BasePoints)*out.BestMultiplier)) - ctx.BasePoints

	// Second pass: build Applied + flat bonus, in input order.
	for i, c := range conds {
		if !c.matches(ctx) {
			continue
		}
		switch c.RewardType {
		case "set_points":
			if c.RewardValue <= 0 {
				continue
			}
			bonus := int(math.Round(c.RewardValue))
			out.FlatBonus += bonus
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, PointsContributed: bonus,
			})
		case "multiply_points":
			if c.RewardValue <= 0 {
				continue
			}
			pc := 0
			if i == bestIdx {
				pc = winnerDelta
			}
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, PointsContributed: pc,
			})
		case "product_reward":
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, RewardProductIDs: c.RewardProductIDs,
			})
		}
	}
	return out
}

// LoyaltyEarnReason builds the human-readable ledger reason for the earn entry.
func LoyaltyEarnReason(orderNumber string, base int, o LoyaltyOutcome) string {
	if o.BestMultiplier == 1.0 && o.FlatBonus == 0 {
		return "Poin dari transaksi " + orderNumber
	}
	parts := "dasar " + itoa(base)
	if o.BestMultiplier != 1.0 {
		parts += " ×" + ftoa(o.BestMultiplier)
	}
	for _, a := range o.Applied {
		if a.RewardType == "set_points" {
			parts += " + " + a.Name + " +" + itoa(a.PointsContributed)
		}
	}
	return "Poin transaksi " + orderNumber + " (" + parts + ")"
}

func itoa(i int) string     { return strconv.Itoa(i) }
func ftoa(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) } // 2.0 → "2", 0.5 → "0.5"

// ProductRewards returns the product_reward conditions that match this order,
// for the checkout fulfillment preview. Reuses the same matching the commit path
// uses (EvaluateLoyalty), so the preview and the authoritative grant agree.
func ProductRewards(conds []LoyaltyCondition, ctx EvalContext) []AppliedCondition {
	out := EvaluateLoyalty(conds, ctx)
	var rewards []AppliedCondition
	for _, a := range out.Applied {
		if a.RewardType == "product_reward" {
			rewards = append(rewards, a)
		}
	}
	return rewards
}
