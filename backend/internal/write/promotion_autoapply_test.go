package write

import "testing"

func boolPtr(b bool) *bool { return &b }

func TestValidatePromotionBasicsAutoApplyCodeOnly(t *testing.T) {
	cases := []struct {
		name    string
		p       Promotion
		wantErr bool
	}{
		{"auto + codeOnly active", Promotion{Type: "bogo", IsActive: true, CodeOnly: true, AutoApply: boolPtr(true)}, true},
		{"auto + codeOnly inactive still rejected", Promotion{Type: "bogo", IsActive: false, CodeOnly: true, AutoApply: boolPtr(true)}, true},
		{"auto alone ok", Promotion{Type: "bogo", IsActive: true, AutoApply: boolPtr(true)}, false},
		{"codeOnly alone ok", Promotion{Type: "bogo", IsActive: true, CodeOnly: true}, false},
		{"codeOnly + explicit false ok", Promotion{Type: "bogo", IsActive: true, CodeOnly: true, AutoApply: boolPtr(false)}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validatePromotionBasics(c.p)
			if (err != nil) != c.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, c.wantErr)
			}
			if err != nil && err.Error() != "Promo otomatis tidak bisa sekaligus hanya via kode" {
				t.Fatalf("unexpected message %q", err.Error())
			}
		})
	}
}
