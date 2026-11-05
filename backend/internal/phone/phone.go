// Package phone holds the canonical phone-number normalizer used for exact customer
// lookup (A30). It has two twins that must stay in lockstep: the SQL function
// normalize_phone() (migration 0061, redefined in 0080) and packages/sync/src/phone.ts. All three are
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

// MaxDigits is the E.164 maximum, country code included.
const MaxDigits = 15

// Normalize returns the canonical key of a phone number, or "" when it is not a usable phone.
//
// Spaces, '-', '.', '(' and ')' are stripped, then:
//   - a leading '+' or '00' marks an international number: the digits that follow are kept
//     (country code 62 folds to the Indonesian local form below);
//   - a leading '0' is an Indonesian local number, kept as is;
//   - a bare '8...' is an Indonesian mobile number missing its 0: '0' is prepended;
//   - a bare '62...' folds to the local form; any other bare digits are kept as international.
//
// Indonesian numbers are keyed as 0xxx so 0812..., 62812... and +62 812... collide. The key
// must be digits only, at least MinDigits long, and within the E.164 limit once the country
// code is counted (MaxDigits), otherwise "".
func Normalize(raw string) string {
	s := strings.TrimFunc(raw, isEdgeSpace)
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '.', '(', ')':
			return -1
		}
		return r
	}, s)
	intl := false
	switch {
	case strings.HasPrefix(s, "+"):
		intl, s = true, s[1:]
	case strings.HasPrefix(s, "00"):
		intl, s = true, s[2:]
	}
	if s == "" {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return ""
		}
	}
	var key string
	switch {
	case intl && strings.HasPrefix(s, "0"):
		return ""
	case strings.HasPrefix(s, "620"):
		key = "0" + s[3:] // +62 (0)812...: the written trunk zero
	case strings.HasPrefix(s, "62"):
		key = "0" + s[2:]
	case !intl && strings.HasPrefix(s, "0"):
		key = s
	case !intl && strings.HasPrefix(s, "8"):
		key = "0" + s
	default:
		key = s
	}
	if len(key) < MinDigits {
		return ""
	}
	digits := len(key)
	if strings.HasPrefix(key, "0") {
		digits++ // '0' stands for the 2-digit country code 62
	}
	if digits > MaxDigits {
		return ""
	}
	return key
}

// MinSearchDigits is the fewest subscriber digits worth searching phone_norm by; shorter
// runs match nearly every customer and cannot use the trigram index.
const MinSearchDigits = 3

// SearchKeys turns text typed into a customer search box into a phone search.
//
// It returns ("", "") unless q is phone-shaped: only digits once spaces, '-', '.', '(' ')' and
// a leading '+' or '00' are removed. Otherwise:
//   - norm is Normalize(q), the full canonical key ("" while the number is still partial);
//   - like is a LIKE pattern over phone_norm, "" when fewer than MinSearchDigits digits follow
//     the country/trunk prefix. A number written with a prefix is a prefix search: 0812-34,
//     62812 34 and +62 812 34 all give '081234%', and a foreign +65 8123 gives '658123%', so
//     a Singapore number is never mistaken for an Indonesian one. Bare digits (8123, 3456) may
//     be any part of the number, so they give '%8123%'.
//
// Callers add `OR phone_norm LIKE like` (trigram indexed) next to the raw-text matches.
func SearchKeys(q string) (norm, like string) {
	s := strings.TrimFunc(q, isEdgeSpace)
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '.', '(', ')':
			return -1
		}
		return r
	}, s)
	intl := false
	switch {
	case strings.HasPrefix(s, "+"):
		intl, s = true, s[1:]
	case strings.HasPrefix(s, "00"):
		intl, s = true, s[2:]
	}
	if s == "" {
		return "", ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return "", ""
		}
	}
	norm = Normalize(q)
	prefix, rest := "", s
	switch {
	case strings.HasPrefix(s, "620"):
		prefix, rest = "0", s[3:]
	case strings.HasPrefix(s, "62"):
		prefix, rest = "0", s[2:]
	case strings.HasPrefix(s, "0"):
		prefix, rest = "0", s[1:]
	case intl:
		rest = s // the foreign country code is part of the key
	}
	if len(rest) < MinSearchDigits {
		return norm, ""
	}
	if prefix != "" || intl {
		return norm, prefix + rest + "%"
	}
	return norm, "%" + rest + "%"
}
