package write

import "testing"

func TestNextDeviceCode(t *testing.T) {
	cases := []struct{ prev, want string }{
		{"", "AA"},
		{"AA", "AB"},
		{"AY", "AZ"},
		{"AZ", "BA"},
		{"BZ", "CA"},
		{"YZ", "ZA"},
		{"ZY", "ZZ"},
		{"ZZ", "AAA"},
		{"AAA", "AAB"},
		{"AAZ", "ABA"},
		{"ZZZ", "AAAA"},
	}
	for _, c := range cases {
		if got := nextDeviceCode(c.prev); got != c.want {
			t.Errorf("nextDeviceCode(%q) = %q, want %q", c.prev, got, c.want)
		}
	}
}

func TestNextDeviceCodeNeverRepeatsOrShrinks(t *testing.T) {
	seen := map[string]bool{}
	code := ""
	for i := 0; i < 26*26+5000; i++ {
		code = nextDeviceCode(code)
		if len(code) < 2 {
			t.Fatalf("code %q shorter than 2 letters", code)
		}
		if seen[code] {
			t.Fatalf("code %q repeated at step %d", code, i)
		}
		seen[code] = true
	}
}
