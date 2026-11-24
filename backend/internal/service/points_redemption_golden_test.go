package service

import (
	"encoding/json"
	"os"
	"testing"
)

type redemptionCase struct {
	Name      string  `json:"name"`
	Requested int     `json:"requested"`
	Available int     `json:"available"`
	Rate      float64 `json:"rate"`
	Total     float64 `json:"total"`
	Expected  struct {
		Points int     `json:"points"`
		Amount float64 `json:"amount"`
	} `json:"expected"`
}

// Same fixture file is read by POS pointsRedemptionParity.test.ts. Never adjust RedeemPoints
// to make a vector pass: change the rule and both sides together.
func TestPointsRedemptionGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/points_redemption_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []redemptionCase
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 17 {
		t.Fatal("golden fixture count changed", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			points, amount := RedeemPoints(tc.Requested, tc.Available, tc.Rate, tc.Total)
			if points != tc.Expected.Points || amount != tc.Expected.Amount {
				t.Fatalf("got points=%d amount=%v want %+v", points, amount, tc.Expected)
			}
		})
	}
}
