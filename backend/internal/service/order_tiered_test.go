package service

import "testing"

func TestParseTieredConfig(t *testing.T) {
	raw := []byte(`{"tiers":[{"minSubtotal":100000,"kind":"fixed","value":10000},{"minSubtotal":250000,"kind":"percentage","value":15}]}`)
	c, err := parseTieredConfig(raw)
	if err != nil || c == nil || len(c.Tiers) != 2 {
		t.Fatalf("parse err=%v c=%v", err, c)
	}
	if c.Tiers[1].Kind != DiscountPercentage || c.Tiers[1].Value != 15 {
		t.Fatalf("bad tier2: %+v", c.Tiers[1])
	}
}
func TestParseTieredConfigNullIsNil(t *testing.T) {
	c, err := parseTieredConfig(nil)
	if err != nil || c != nil {
		t.Fatalf("nil raw → nil,nil; got %v,%v", c, err)
	}
}
