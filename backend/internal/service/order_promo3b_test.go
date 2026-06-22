package service

import "testing"

func TestParseBXGYConfig(t *testing.T) {
	raw := []byte(`{"buyQuantity":2,"getQuantity":1,"buyProductIds":["a"],"getProductIds":["b|10ml"],"getDiscountKind":"percentage","getDiscountValue":100,"maxApplications":3}`)
	c, err := parseBXGYConfig(raw)
	if err != nil || c == nil {
		t.Fatalf("parse err=%v c=%v", err, c)
	}
	if c.BuyQuantity != 2 || c.GetQuantity != 1 || c.GetDiscountValue != 100 || c.MaxApplications != 3 {
		t.Fatalf("bad parse: %+v", c)
	}
	if len(c.GetProductIDs) != 1 || c.GetProductIDs[0] != "b|10ml" {
		t.Fatalf("bad getProductIds: %+v", c.GetProductIDs)
	}
}

func TestParseBXGYConfigNullIsNil(t *testing.T) {
	c, err := parseBXGYConfig(nil)
	if err != nil || c != nil {
		t.Fatalf("nil raw should give nil,nil got %v,%v", c, err)
	}
}
