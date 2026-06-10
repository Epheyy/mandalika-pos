package service

import (
	"testing"
	"time"
)

// helper: a WIB date at noon (so .In(WIB) day math is unambiguous).
func wibDate(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 12, 0, 0, 0, time.FixedZone("WIB", 7*3600))
}
func fptr(f float64) *float64 { return &f }

func baseCtx() EvalContext {
	return EvalContext{
		Total: 50000, BasePoints: 50, ProductIDs: map[string]bool{"p1": true},
		SaleDate: wibDate(2026, 6, 6), // Sat 6 June 2026 → double_date (day 6 == month 6)
		Customer: EvalCustomer{VisitCount: 3},
	}
}

func TestEvaluate_NoConditions_ParityWithBase(t *testing.T) {
	o := EvaluateLoyalty(nil, baseCtx())
	if o.BestMultiplier != 1.0 || o.FlatBonus != 0 || len(o.Applied) != 0 {
		t.Fatalf("expected inert outcome, got %+v", o)
	}
	if got := o.FinalEarned(50); got != 50 {
		t.Fatalf("FinalEarned parity: want 50, got %d", got)
	}
}

func TestEvaluate_SpendingThreshold_SetPoints(t *testing.T) {
	conds := []LoyaltyCondition{{
		ID: "c1", Name: "Belanja 50rb", Type: "always_on", Trigger: "spending_threshold",
		RewardType: "set_points", RewardValue: 100, MinimumSpend: fptr(50000), IsActive: true,
	}}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.FlatBonus != 100 || o.BestMultiplier != 1.0 {
		t.Fatalf("want flat 100 ×1, got %+v", o)
	}
	if got := o.FinalEarned(50); got != 150 {
		t.Fatalf("want 150, got %d", got)
	}
	if len(o.Applied) != 1 || o.Applied[0].PointsContributed != 100 {
		t.Fatalf("applied attribution wrong: %+v", o.Applied)
	}
}

func TestEvaluate_BestMultiplier_NoCompound(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "m2", Name: "x2", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 2, IsActive: true},
		{ID: "m3", Name: "x3", Type: "always_on", Trigger: "spending_threshold", RewardType: "multiply_points", RewardValue: 3, MinimumSpend: fptr(50000), IsActive: true},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.BestMultiplier != 3 {
		t.Fatalf("want best ×3 (no compound), got %v", o.BestMultiplier)
	}
	if got := o.FinalEarned(50); got != 150 { // round(50*3)+0
		t.Fatalf("want 150, got %d", got)
	}
	// winner (m3) records 100 (150-50); loser (m2) records 0.
	var winner, loser int
	for _, a := range o.Applied {
		if a.ConditionID == "m3" {
			winner = a.PointsContributed
		}
		if a.ConditionID == "m2" {
			loser = a.PointsContributed
		}
	}
	if winner != 100 || loser != 0 {
		t.Fatalf("attribution: winner=%d loser=%d", winner, loser)
	}
}

func TestEvaluate_MultiplierThenFlatBonus(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "m", Name: "x2", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 2, IsActive: true},
		{ID: "s", Name: "+30", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 30, IsActive: true},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if got := o.FinalEarned(50); got != 130 { // round(50*2)+30
		t.Fatalf("want 130, got %d", got)
	}
}

func TestEvaluate_RewardValueZeroIgnored(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "z", Name: "x0", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 0, IsActive: true},
		{ID: "n", Name: "-5", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: -5, IsActive: true},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.BestMultiplier != 1.0 || o.FlatBonus != 0 {
		t.Fatalf("zero/negative reward_value must be ignored, got %+v", o)
	}
}

func TestEvaluate_Birthday_ExactMMDD(t *testing.T) {
	bday := time.Date(1990, 6, 6, 0, 0, 0, 0, time.UTC)
	ctx := baseCtx()
	ctx.Customer = EvalCustomer{VisitCount: 1, Birthday: &bday}
	conds := []LoyaltyCondition{{ID: "b", Name: "Ultah", Type: "always_on", Trigger: "birthday", RewardType: "set_points", RewardValue: 200, IsActive: true}}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 200 {
		t.Fatalf("birthday match expected, got %+v", o)
	}
	// Non-birthday day → no match.
	ctx.SaleDate = wibDate(2026, 7, 1)
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 0 {
		t.Fatalf("non-birthday must not match, got %+v", o)
	}
}

func TestEvaluate_FirstRegistration_OnlyVisitZero(t *testing.T) {
	conds := []LoyaltyCondition{{ID: "fr", Name: "Welcome", Type: "always_on", Trigger: "first_registration", RewardType: "set_points", RewardValue: 500, IsActive: true}}
	ctx := baseCtx()
	ctx.Customer = EvalCustomer{VisitCount: 0}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 500 {
		t.Fatalf("first registration should fire at visit 0, got %+v", o)
	}
	ctx.Customer = EvalCustomer{VisitCount: 1}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 0 {
		t.Fatalf("should not fire after first visit, got %+v", o)
	}
}

func TestEvaluate_MemberDay_Weekday(t *testing.T) {
	// 2026-06-06 is a Saturday (weekday 6).
	conds := []LoyaltyCondition{{ID: "md", Name: "Sabtu", Type: "always_on", Trigger: "member_day", RewardType: "set_points", RewardValue: 25, ActiveDays: []int{6}, IsActive: true}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 25 {
		t.Fatalf("member_day Saturday should match, got %+v", o)
	}
	conds[0].ActiveDays = []int{1} // Monday only
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("member_day Monday should not match Saturday, got %+v", o)
	}
}

func TestEvaluate_ProductPurchase_Intersection(t *testing.T) {
	conds := []LoyaltyCondition{{ID: "pp", Name: "Beli p1", Type: "always_on", Trigger: "product_purchase", RewardType: "set_points", RewardValue: 40, ApplicableProductIDs: []string{"p1", "p9"}, IsActive: true}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 40 {
		t.Fatalf("product_purchase should match p1, got %+v", o)
	}
	conds[0].ApplicableProductIDs = []string{"p9"}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("product_purchase should not match, got %+v", o)
	}
}

func TestEvaluate_CampaignWindow_InclusiveEdges(t *testing.T) {
	start := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	conds := []LoyaltyCondition{{ID: "cm", Name: "Hari ini", Type: "campaign", Trigger: "double_date", RewardType: "set_points", RewardValue: 10, CampaignStartDate: &start, CampaignEndDate: &end, IsActive: true}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 10 {
		t.Fatalf("campaign on the edge day should match, got %+v", o)
	}
	out := baseCtx()
	out.SaleDate = wibDate(2026, 6, 7) // day 7 ≠ month 6, and outside window anyway
	if o := EvaluateLoyalty(conds, out); o.FlatBonus != 0 {
		t.Fatalf("outside campaign must not match, got %+v", o)
	}
}

func TestEvaluate_InactiveSkipped(t *testing.T) {
	// loadActiveConditions only returns active rows, but guard anyway if IsActive present.
	conds := []LoyaltyCondition{{ID: "x", Name: "off", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 99, IsActive: false}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("inactive condition must not fire, got %+v", o)
	}
}

func TestEvaluate_WIBMidnightBoundary(t *testing.T) {
	// 2026-06-05 22:00Z == 2026-06-06 05:00 WIB → must evaluate as June 6 (double_date).
	utcInstant := time.Date(2026, 6, 5, 22, 0, 0, 0, time.UTC)
	ctx := baseCtx()
	ctx.SaleDate = utcInstant.In(time.FixedZone("WIB", 7*3600))
	conds := []LoyaltyCondition{{ID: "dd", Name: "DoubleDate", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 60, IsActive: true}}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 60 {
		t.Fatalf("WIB-day June 6 double_date should match, got %+v", o)
	}
}

func TestLoyaltyEarnReason(t *testing.T) {
	if got := LoyaltyEarnReason("MDK-1", 50, LoyaltyOutcome{BestMultiplier: 1.0}); got != "Poin dari transaksi MDK-1" {
		t.Fatalf("plain reason wrong: %q", got)
	}
	o := LoyaltyOutcome{BestMultiplier: 2, FlatBonus: 100, Applied: []AppliedCondition{
		{Name: "Ulang Tahun", RewardType: "set_points", PointsContributed: 100},
	}}
	want := "Poin transaksi MDK-1 (dasar 50 ×2 + Ulang Tahun +100)"
	if got := LoyaltyEarnReason("MDK-1", 50, o); got != want {
		t.Fatalf("breakdown reason: want %q got %q", want, got)
	}
}
