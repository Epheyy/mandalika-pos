package service

import "github.com/mandalika/pos-backend/internal/rules"

// IsCashMethod is a compatibility alias; the rule lives in internal/rules.
var IsCashMethod = rules.IsCashMethod

// Loyalty engine aliases (implementation in internal/rules/loyalty.go).
type (
	LoyaltyCondition = rules.LoyaltyCondition
	EvalCustomer     = rules.EvalCustomer
	EvalContext      = rules.EvalContext
	AppliedCondition = rules.AppliedCondition
	LoyaltyOutcome   = rules.LoyaltyOutcome
)

var (
	EvaluateLoyalty   = rules.EvaluateLoyalty
	LoyaltyEarnReason = rules.LoyaltyEarnReason
	ProductRewards    = rules.ProductRewards
)
