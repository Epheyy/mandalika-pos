// Package phone holds the canonical phone-number normalizer used for exact customer
// lookup (A30). It has two twins that must stay in lockstep: the SQL function
// normalize_phone() (migration 0061) and packages/sync/src/phone.ts. All three are
// tested against packages/sync/src/__fixtures__/phone-vectors.json.
package phone

import "strings"

// MinDigits is the shortest normalized number we treat as a real phone number.
const MinDigits = 8

// Normalize trims the value, strips spaces, '-', '.', '(' and ')', accepts one
// leading '+', folds a leading country code 62 to 0, and requires digits only.
// It returns "" when the result is not a plausible phone (non-digit characters, or
// fewer than MinDigits digits).
func Normalize(raw string) string {
	s := strings.TrimSpace(raw)
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
