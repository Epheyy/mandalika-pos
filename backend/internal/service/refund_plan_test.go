package service

import (
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
)

func i64(v int64) *int64 { return &v }
func ip(v int) *int      { return &v }

func TestValidateRefundExtras(t *testing.T) {
	ok := []RefundItemInput{{LineNo: 0, Quantity: 1}, {LineNo: 3, Quantity: 2}}
	for _, tc := range []struct {
		name    string
		items   []RefundItemInput
		code    string
		want    string
		wantErr error
	}{
		{"legacy nil items", nil, "", "", nil},
		{"items ok + code", ok, " rusak-cacat_1 ", "rusak-cacat_1", nil},
		{"empty non-nil items", []RefundItemInput{}, "", "", ErrRefundLineUnknown},
		{"zero quantity", []RefundItemInput{{1, 0}}, "", "", ErrRefundLineUnknown},
		{"negative line", []RefundItemInput{{-1, 1}}, "", "", ErrRefundLineUnknown},
		{"duplicate line", []RefundItemInput{{1, 1}, {1, 2}}, "", "", ErrRefundLineUnknown},
		{"code upper-case", nil, "Rusak", "", ErrRefundReasonCodeInvalid},
		{"code too long", nil, strings.Repeat("a", maxRefundReasonCodeRunes+1), "", ErrRefundReasonCodeInvalid},
		{"code at cap", nil, strings.Repeat("a", maxRefundReasonCodeRunes), strings.Repeat("a", maxRefundReasonCodeRunes), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateRefundExtras(tc.items, tc.code)
			if err != tc.wantErr || got != tc.want {
				t.Fatalf("got %q,%v want %q,%v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestRefundErrorsC4a(t *testing.T) {
	for _, tc := range []struct {
		err  *apperr.Error
		code apperr.Code
	}{
		{ErrRefundQtyExceeded, apperr.Conflict},
		{ErrRefundPartialNeedsNewApp, apperr.Conflict},
		{ErrRefundGroupSplit, apperr.Rejected},
		{ErrRefundLegacyWholeOnly, apperr.Rejected},
		{ErrRefundLineUnknown, apperr.Rejected},
		{ErrRefundReasonCodeInvalid, apperr.Rejected},
	} {
		if tc.err.ErrorCode() != tc.code {
			t.Errorf("%q code=%s want %s", tc.err, tc.err.ErrorCode(), tc.code)
		}
		if !strings.Contains(tc.err.Error(), "jangan bayar ulang.") {
			t.Errorf("%q missing warning", tc.err)
		}
	}
	if !strings.Contains(ErrRefundPartialNeedsNewApp.Error(), "Sebagian transaksi ini sudah direfund dari tablet lain. Perbarui aplikasi lalu refund sisa barang.") {
		t.Error("partial-needs-new-app text changed")
	}
}

func TestResolveRefundAmount(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		claimed                *int64
		computed, prior, total int64
		wantAmount             int64
		wantWarn               string
		wantClaimed            *int64
	}{
		{"no claim uses computed", nil, 1000, 0, 5000, 1000, "", nil},
		{"claim equal", i64(1000), 1000, 0, 5000, 1000, "", i64(1000)},
		{"claim within Rp1", i64(1001), 1000, 0, 5000, 1001, "", i64(1001)},
		{"claim off by 2", i64(1002), 1000, 0, 5000, 1002, RefundWarnAmountMismatch, i64(1002)},
		{"claim lower by 2", i64(998), 1000, 0, 5000, 998, RefundWarnAmountMismatch, i64(998)},
		{"negative claim ignored", i64(-5), 1000, 0, 5000, 1000, RefundWarnAmountMismatch, nil},
		{"huge claim ignored", i64(maxRefundAmountRp + 1), 1000, 0, 5000, 1000, RefundWarnAmountMismatch, nil},
		// D-49: the amount of record never exceeds what the order still has left (total - prior);
		// the claim is kept as information and the flag still says why.
		{"claim above remaining is capped", i64(4500), 1000, 1000, 5000, 4000, RefundWarnOverTotal, i64(4500)},
		{"claim within remaining stays the fact", i64(800), 1000, 1000, 5000, 800, RefundWarnAmountMismatch, i64(800)},
		{"claim = remaining+1 capped, no flag", i64(2001), 2000, 3000, 5000, 2000, "", i64(2001)},
		{"claim remaining+2 capped and flagged", i64(2002), 2002, 3000, 5000, 2000, RefundWarnOverTotal, i64(2002)},
		{"order already over-refunded earlier: record 0", i64(300), 300, 6000, 5000, 0, RefundWarnOverTotal, i64(300)},
		{"computed above remaining is capped too", nil, 2500, 3000, 5000, 2000, RefundWarnOverTotal, nil},
		{"two refunds whose sum would exceed", i64(3000), 3000, 3000, 5000, 2000, RefundWarnOverTotal, i64(3000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, w, c := ResolveRefundAmount(tc.claimed, tc.computed, tc.prior, tc.total)
			if a != tc.wantAmount || w != tc.wantWarn {
				t.Fatalf("got %d,%q want %d,%q", a, w, tc.wantAmount, tc.wantWarn)
			}
			if (c == nil) != (tc.wantClaimed == nil) || (c != nil && *c != *tc.wantClaimed) {
				t.Fatalf("claimed kept = %v want %v", c, tc.wantClaimed)
			}
		})
	}
}

func TestClawTarget(t *testing.T) {
	for _, tc := range []struct {
		points, refunded, total int64
		complete                bool
		want                    int64
	}{
		{100, 0, 1000, false, 0},
		{100, 333, 1000, false, 33},
		{100, 667, 1000, false, 66},
		{100, 1000, 1000, false, 100},
		{100, 10, 1000, true, 100},
		{0, 500, 1000, false, 0},
		{100, 500, 0, false, 0},  // Rp0 order: partial settles nothing
		{100, 500, 0, true, 100}, // ...the completing refund settles all
	} {
		if got := ClawTarget(tc.points, tc.refunded, tc.total, tc.complete); got != tc.want {
			t.Errorf("ClawTarget(%d,%d,%d,%v)=%d want %d", tc.points, tc.refunded, tc.total, tc.complete, got, tc.want)
		}
	}
	// Cumulative rounding: successive deltas sum to the full amount at completion.
	var took, cum int64
	for _, step := range []int64{333, 333} {
		cum += step
		took += ClawTarget(101, cum, 1000, false) - took
	}
	took += ClawTarget(101, 1000, 1000, true) - took
	if took != 101 {
		t.Fatalf("cumulative points = %d want 101", took)
	}
}

// Three plain lines, net 1000/500/333 (total 1833), line_no 0..2.
func plainLines() []refundLine {
	return []refundLine{
		{ID: "a", LineNo: ip(0), Net: i64(1000), Subtotal: 1100, Qty: 2},
		{ID: "b", LineNo: ip(1), Net: i64(500), Subtotal: 500, Qty: 1},
		{ID: "c", LineNo: ip(2), Net: i64(333), Subtotal: 400, Qty: 3},
	}
}

func TestPlanRefundLegacyAllLines(t *testing.T) {
	picks, completes, err := planRefund(plainLines(), nil)
	if err != nil || !completes || len(picks) != 3 {
		t.Fatalf("picks=%v completes=%v err=%v", picks, completes, err)
	}
	if picks[0].Amount != 1000 || picks[2].Amount != 333 || picks[2].Qty != 3 {
		t.Fatalf("amounts %+v", picks)
	}
	// a legacy order without nets falls back to the subtotal
	legacy := []refundLine{{ID: "x", Subtotal: 700, Qty: 2}}
	picks, _, err = planRefund(legacy, nil)
	if err != nil || picks[0].Amount != 700 {
		t.Fatalf("legacy fallback %+v %v", picks, err)
	}
	prior := plainLines()
	prior[0].Prior = 1
	if _, _, err = planRefund(prior, nil); err != ErrRefundPartialNeedsNewApp {
		t.Fatalf("err=%v", err)
	}
}

func TestPlanRefundItems(t *testing.T) {
	// partial: 1 of 2 of line 0 -> floor(1000/2)=500; not complete
	picks, completes, err := planRefund(plainLines(), []RefundItemInput{{0, 1}})
	if err != nil || completes || len(picks) != 1 || picks[0].Amount != 500 {
		t.Fatalf("%+v %v %v", picks, completes, err)
	}
	// everything at once completes
	_, completes, err = planRefund(plainLines(), []RefundItemInput{{0, 2}, {1, 1}, {2, 3}})
	if err != nil || !completes {
		t.Fatalf("completes=%v err=%v", completes, err)
	}
	// a later refund of line 2 settles the remainder exactly
	ls := plainLines()
	ls[2].Prior = 1
	picks, _, _ = planRefund(ls, []RefundItemInput{{2, 2}})
	if picks[0].Amount != 333-RefundCum(333, 3, 1) {
		t.Fatalf("remainder amount %d", picks[0].Amount)
	}
	// completes when earlier refunds plus this one cover every unit
	ls = plainLines()
	ls[0].Prior, ls[1].Prior, ls[2].Prior = 2, 1, 1
	if _, c, e := planRefund(ls, []RefundItemInput{{2, 2}}); e != nil || !c {
		t.Fatalf("c=%v e=%v", c, e)
	}
}

func TestPlanRefundErrors(t *testing.T) {
	if _, _, err := planRefund(plainLines(), []RefundItemInput{{9, 1}}); err != ErrRefundLineUnknown {
		t.Errorf("unknown line: %v", err)
	}
	if _, _, err := planRefund(plainLines(), []RefundItemInput{{0, 3}}); err != ErrRefundQtyExceeded {
		t.Errorf("over qty: %v", err)
	}
	ls := plainLines()
	ls[0].Prior = 1
	if _, _, err := planRefund(ls, []RefundItemInput{{0, 2}}); err != ErrRefundQtyExceeded {
		t.Errorf("over remaining: %v", err)
	}
	// a pre-0077 order cannot take items
	legacy := plainLines()
	legacy[1].LineNo = nil
	if _, _, err := planRefund(legacy, []RefundItemInput{{0, 1}}); err != ErrRefundLegacyWholeOnly {
		t.Errorf("legacy: %v", err)
	}
	nonet := plainLines()
	nonet[1].Net = nil
	if _, _, err := planRefund(nonet, []RefundItemInput{{0, 1}}); err != ErrRefundLegacyWholeOnly {
		t.Errorf("no net: %v", err)
	}
}

func TestPlanRefundGroups(t *testing.T) {
	mk := func() []refundLine {
		return []refundLine{
			{ID: "a", LineNo: ip(0), Net: i64(900), Group: "bundle:p:0", Qty: 1},
			{ID: "b", LineNo: ip(1), Net: i64(0), Group: "bundle:p:0", Qty: 1},
			{ID: "c", LineNo: ip(2), Net: i64(100), Qty: 1},
		}
	}
	if _, _, err := planRefund(mk(), []RefundItemInput{{0, 1}}); err != ErrRefundGroupSplit {
		t.Errorf("one member only: %v", err)
	}
	picks, completes, err := planRefund(mk(), []RefundItemInput{{0, 1}, {1, 1}})
	if err != nil || completes || len(picks) != 2 {
		t.Errorf("whole group: %+v %v %v", picks, completes, err)
	}
	if _, _, err := planRefund(mk(), []RefundItemInput{{2, 1}}); err != nil {
		t.Errorf("independent line: %v", err)
	}
	// a partly refunded group cannot be split further
	ls := mk()
	ls[1].Prior = 1
	if _, _, err := planRefund(ls, []RefundItemInput{{0, 1}}); err != ErrRefundGroupSplit {
		t.Errorf("partially refunded group: %v", err)
	}
}

func TestRefundComputedAmountAbsorbsDrift(t *testing.T) {
	picks := []refundPick{{Amount: 400}, {Amount: 100}}
	if got := refundComputedAmount(picks, false, 2000, 700); got != 500 {
		t.Errorf("partial = %d", got)
	}
	// the completing refund = total - previous computed, whatever the lines say
	if got := refundComputedAmount(picks, true, 2000, 1450); got != 550 {
		t.Errorf("completing = %d", got)
	}
	if got := refundComputedAmount(picks, true, 2000, 2100); got != 0 {
		t.Errorf("floor = %d", got)
	}
}

func TestRefundScope(t *testing.T) {
	if refundScope(true, 0) != "full" || refundScope(true, 2) != "partial" || refundScope(false, 0) != "partial" {
		t.Fatal("scope rules")
	}
}

// A Rp0 order paid entirely with 500 redeemed points, two items: the first (partial) refund
// restores nothing, the final one restores all 500.
func TestZeroTotalOrderPointsSettleOnlyOnCompletion(t *testing.T) {
	lines := []refundLine{
		{ID: "a", LineNo: ip(0), Net: i64(0), Subtotal: 300, Qty: 1},
		{ID: "b", LineNo: ip(1), Net: i64(0), Subtotal: 200, Qty: 1},
	}
	picks, completes, err := planRefund(lines, []RefundItemInput{{0, 1}})
	if err != nil || completes {
		t.Fatalf("partial: %v %v", completes, err)
	}
	computed := refundComputedAmount(picks, completes, 0, 0)
	if got := ClawTarget(500, computed, 0, completes); got != 0 {
		t.Fatalf("partial restores %d, want 0", got)
	}
	lines[0].Prior = 1
	picks, completes, err = planRefund(lines, []RefundItemInput{{1, 1}})
	if err != nil || !completes {
		t.Fatalf("final: %v %v", completes, err)
	}
	computed = refundComputedAmount(picks, completes, 0, 0)
	if got := ClawTarget(500, computed, 0, completes); got != 500 {
		t.Fatalf("final restores %d, want 500", got)
	}
}

func TestPlanRefundClampsNegativeLegacySubtotal(t *testing.T) {
	picks, _, err := planRefund([]refundLine{{ID: "x", Subtotal: -50, Qty: 1}}, nil)
	if err != nil || picks[0].Amount != 0 {
		t.Fatalf("%+v %v", picks, err)
	}
}
