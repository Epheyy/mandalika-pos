// Package phone holds the canonical phone-number normalizer used for exact customer
// lookup (A30). It has two twins that must stay in lockstep: the SQL function
// normalize_phone() (migration 0061) and packages/sync/src/phone.ts. All three are
// tested against packages/sync/src/__fixtures__/phone-vectors.json.
package phone

import "strings"

// MinDigits is the shortest normalized number we treat as a real phone number.
const MinDigits = 8

// isEdgeSpace is the explicit set trimmed from both ends. Go's TrimSpace and JavaScript's trim()
// disagree (U+0085 vs U+FEFF), so all three twins use this one list: ASCII whitespace (tab to
// carriage return, and space), U+0085, U+00A0, U+FEFF, U+1680, U+2000-U+200A, U+2028, U+2029,
// U+202F, U+205F and U+3000.
func isEdgeSpace(r rune) bool {
	switch {
	case r == ' ', r >= 0x09 && r <= 0x0D:
		return true
	case r == 0x85, r == 0xA0, r == 0xFEFF, r == 0x1680, r == 0x2028, r == 0x2029, r == 0x202F, r == 0x205F, r == 0x3000:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Normalize trims the value, strips spaces, '-', '.', '(' and ')', accepts one
// leading '+', folds a leading country code 62 to 0, and requires digits only.
// It returns "" when the result is not a plausible phone (non-digit characters, or
// fewer than MinDigits digits).
func Normalize(raw string) string {
	s := strings.TrimFunc(raw, isEdgeSpace)
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '.', '(', ')':
			return -1
		}
		return r
	}, s)
	s = strings.TrimPrefix(s, "+")
	if s == "" {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return ""
		}
	}
	if strings.HasPrefix(s, "62") {
		s = "0" + s[2:]
	}
	if len(s) < MinDigits {
		return ""
	}
	return s
}
