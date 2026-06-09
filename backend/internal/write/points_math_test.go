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
	cases := []struct {
		balance, delta, want int
		wantErr              bool
	}{
		{100, 0, 0, true},
		{10, -50, 0, true},
		{10, 25, 35, false},
		{50, -50, 0, false},
		{30, -30, 0, false},
	}
	for _, c := range cases {
		got, err := adjustedBalance(c.balance, c.delta)
		if c.wantErr {
			if err == nil {
				t.Errorf("adjustedBalance(%d,%d) expected error", c.balance, c.delta)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("adjustedBalance(%d,%d)=%d,%v want %d,nil", c.balance, c.delta, got, err, c.want)
		}
	}
}
