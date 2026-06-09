package write

import "testing"

func TestPointsClawback(t *testing.T) {
	cases := []struct{ balance, earned, want int }{
		{100, 30, 30}, // normal: claw back all earned
		{20, 30, 20},  // over-spent: floor at 0, forgive 10
		{0, 30, 0},    // empty balance: nothing to claw
		{100, 0, 0},   // nothing earned
		{50, 50, 50},  // exact
	}
	for _, c := range cases {
		if got := PointsClawback(c.balance, c.earned); got != c.want {
			t.Errorf("PointsClawback(%d,%d)=%d want %d", c.balance, c.earned, got, c.want)
		}
	}
}

func TestAdjustedBalance(t *testing.T) {
	if _, err := adjustedBalance(100, 0); err == nil {
		t.Error("delta=0 should error")
	}
	if _, err := adjustedBalance(10, -50); err == nil {
		t.Error("subtracting more than balance should error")
	}
	if nb, err := adjustedBalance(10, 25); err != nil || nb != 35 {
		t.Errorf("add: got %d,%v want 35,nil", nb, err)
	}
	if nb, err := adjustedBalance(50, -50); err != nil || nb != 0 {
		t.Errorf("subtract-to-zero: got %d,%v want 0,nil", nb, err)
	}
}
