package write

import "testing"

func TestValidateDiscountValue(t *testing.T) {
	cases := []struct {
		name    string
		typ     string
		value   float64
		wantErr bool
	}{
		{"percentage zero", "percentage", 0, true},
		{"percentage negative", "percentage", -5, true},
		{"percentage over 100", "percentage", 100.5, true},
		{"percentage 100 ok", "percentage", 100, false},
		{"percentage 10 ok", "percentage", 10, false},
		{"fixed zero", "fixed", 0, true},
		{"fixed negative", "fixed", -1, true},
		{"fixed 5000 ok", "fixed", 5000, false},
		{"fixed above 100 ok", "fixed", 250000, false},
		{"bogo zero ok", "bogo", 0, false},
		{"tiered zero ok", "tiered", 0, false},
		{"bxgy zero ok", "buy_x_get_y", 0, false},
		{"bundle zero ok", "bundle", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateDiscountValue(c.typ, c.value)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateDiscountValue(%q,%v) err=%v wantErr=%v", c.typ, c.value, err, c.wantErr)
			}
		})
	}
}

func TestValidateDateOrder(t *testing.T) {
	cases := []struct {
		name       string
		start, end string
		wantErr    bool
	}{
		{"both empty", "", "", false},
		{"only start", "2026-11-01", "", false},
		{"only end", "", "2026-11-01", false},
		{"same day", "2026-11-01", "2026-11-01", false},
		{"end after", "2026-11-01", "2026-12-01", false},
		{"end before", "2026-11-02", "2026-11-01", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := validateDateOrder(c.start, c.end); (err != nil) != c.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
