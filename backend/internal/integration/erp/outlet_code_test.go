package erp

import "testing"

func TestValidPOSOutletCode(t *testing.T) {
	for _, c := range []string{"BSD", "TSM-CBB", "A1", "ABCDEFGHIJ0123456789"} {
		if !ValidPOSOutletCode(c) {
			t.Errorf("ValidPOSOutletCode(%q) = false, want true", c)
		}
	}
	for _, c := range []string{"A", "-BSD", "BSD-", "BS D", "bsd", "ABCDEFGHIJ01234567890", ""} {
		if ValidPOSOutletCode(c) {
			t.Errorf("ValidPOSOutletCode(%q) = true, want false", c)
		}
	}
}
