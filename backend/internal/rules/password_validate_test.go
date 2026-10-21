package rules

import (
	"errors"
	"strings"
	"testing"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"empty", "", false},
		{"seven ascii", "abcdefg", false},
		{"eight ascii", "abcdefgh", true},
		{"seven multibyte runes", "ééééééé", false}, // 14 bytes, 7 runes
		{"eight multibyte runes", "éééééééé", true},
		{"128 runes", strings.Repeat("a", 128), true},
		{"129 runes", strings.Repeat("a", 129), false},
		{"128 multibyte runes", strings.Repeat("é", 128), true},
	}
	for _, c := range cases {
		err := ValidatePassword(c.in)
		if c.ok && err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
		}
		if !c.ok && !errors.Is(err, ErrWeakPassword) {
			t.Errorf("%s: want ErrWeakPassword, got %v", c.name, err)
		}
	}
}
