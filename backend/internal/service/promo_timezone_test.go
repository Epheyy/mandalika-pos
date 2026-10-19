package service

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/bizday"
)

// A28 Phase B: gating runs on the order outlet's local clock. The vectors file is shared with
// the POS twin (promoValidate.test.ts) and the PL Postgres gate; never edit it to match an engine.
func TestPromoTimezoneVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/promo_timezone_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Kind, Tz, At string
		Row                struct {
			StartDate, EndDate, ActiveFromHour, ActiveToHour string
			ActiveDays                                       []int
		}
		Want []string
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) != 16 {
		t.Fatalf("vector count %d, fixture is pinned at 16", len(vectors))
	}
	day := func(s string) *time.Time {
		if s == "" {
			return nil
		}
		d, e := time.Parse("2006-01-02", s)
		if e != nil {
			t.Fatal(e)
		}
		return &d
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			at, e := time.Parse(time.RFC3339, v.At)
			if e != nil {
				t.Fatal(e)
			}
			ec := PromoEvalContext{SaleTimeLocal: at.In(bizday.Zone(v.Tz)), OutletID: "o", Subtotal: 100000}
			var got []PromoViolation
			if v.Kind == "promo" {
				got = ValidatePromo(PromoRow{StartDate: day(v.Row.StartDate), EndDate: day(v.Row.EndDate),
					ActiveFromHour: v.Row.ActiveFromHour, ActiveToHour: v.Row.ActiveToHour, ActiveDays: v.Row.ActiveDays}, ec)
			} else {
				got = ValidateCode(CodeRow{StartDate: day(v.Row.StartDate), EndDate: day(v.Row.EndDate)}, ec)
			}
			var gs []string
			for _, g := range got {
				gs = append(gs, string(g))
			}
			if strings.Join(gs, ",") != strings.Join(v.Want, ",") {
				t.Fatalf("got %v want %v", gs, v.Want)
			}
		})
	}
}

// Loyalty date triggers use the outlet-local date of the sale.
func TestEvaluate_BirthdayOutletLocalDate(t *testing.T) {
	cond := LoyaltyCondition{ID: "bd", Name: "Birthday", Type: "always_on", Trigger: "birthday", RewardType: "set_points", RewardValue: 200, IsActive: true}
	birthday := time.Date(1990, 10, 19, 0, 0, 0, 0, time.UTC)
	eval := func(at time.Time, tz string) bool {
		ctx := EvalContext{Total: 100000, BasePoints: 100, ProductIDs: map[string]bool{},
			SaleDate: at.In(bizday.Zone(tz)), Customer: EvalCustomer{Birthday: &birthday}}
		return len(EvaluateLoyalty([]LoyaltyCondition{cond}, ctx).Applied) > 0
	}
	if !eval(time.Date(2026, 10, 19, 15, 30, 0, 0, time.UTC), "Asia/Makassar") {
		t.Error("23:30 WITA on 10-19 must match a 10-19 birthday")
	}
	if eval(time.Date(2026, 10, 19, 16, 30, 0, 0, time.UTC), "Asia/Makassar") {
		t.Error("00:30 WITA on 10-20 must not match a 10-19 birthday")
	}
	if !eval(time.Date(2026, 10, 19, 16, 30, 0, 0, time.UTC), "Asia/Jakarta") {
		t.Error("23:30 WIB on 10-19 must match a 10-19 birthday")
	}
}
