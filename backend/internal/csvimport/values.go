package csvimport

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Field length caps (runes). Values over the cap are errors, never truncated.
const (
	MaxName  = 200
	MaxText  = 2000
	MaxCode  = 64 // SKU / barcode
	MaxUnit  = 50
	maxMoney = 1e12 // numeric(14,2) headroom
)

var (
	errBlank = errors.New("kosong")

	digitsOnly       = regexp.MustCompile(`^\d+$`)
	scientific       = regexp.MustCompile(`^\d+([.,]\d+)?[eE][+-]\d+$`) // Excel always writes the sign (8.99E+12); "12E3" can be a real SKU
	phoneShape       = regexp.MustCompile(`^\+?\d{6,20}$`)
	emailShape       = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	dateISO          = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})$`)
	dateDMY          = regexp.MustCompile(`^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$`)
	phoneNoise       = strings.NewReplacer(" ", "", "-", "", ".", "", "(", "", ")", "", "\t", "")
	minYear, maxYear = 1900, 2100
)

// ParseRupiah reads an Indonesian-style amount. It accepts plain digits and ONE kind of
// thousands separator with strict 3-digit groups ("150.000", "150,000", "1.250.000"), an
// optional "Rp" prefix, and (allowFraction only) one separator followed by 1-2 digits
// ("12,5", "12.50"). A 3-digit tail is always grouping, never a fraction. Blank,
// negative, mixed-separator and malformed values are errors; nothing is guessed.
func ParseRupiah(s string, allowFraction bool) (float64, error) {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && strings.EqualFold(s[:2], "rp") {
		s = s[2:]
		if strings.HasPrefix(s, ".") && len(s) > 1 && (s[1] == ' ' || s[1] == '\t') {
			s = s[1:]
		}
		s = strings.TrimSpace(s)
	}
	if s == "" {
		return 0, errBlank
	}
	hasDot, hasComma := false, false
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
		case r == '.':
			hasDot = true
		case r == ',':
			hasComma = true
		default:
			return 0, fmt.Errorf("angka tidak valid")
		}
	}
	if hasDot && hasComma {
		return 0, fmt.Errorf("pemisah angka bercampur (titik dan koma)")
	}
	if !hasDot && !hasComma {
		return finishMoney(s, "")
	}
	sep := "."
	if hasComma {
		sep = ","
	}
	parts := strings.Split(s, sep)
	for _, p := range parts {
		if p == "" {
			return 0, fmt.Errorf("angka tidak valid")
		}
	}
	grouping := len(parts[0]) <= 3
	for _, p := range parts[1:] {
		if len(p) != 3 {
			grouping = false
		}
	}
	if grouping {
		// "0,125", "0.500", "000.500": a leading 0 makes grouping versus decimal ambiguous.
		if parts[0][0] == '0' {
			return 0, fmt.Errorf("format angka ambigu: angka diawali 0 dengan pemisah; tulis tanpa pemisah")
		}
		return finishMoney(strings.Join(parts, ""), "")
	}
	if allowFraction && len(parts) == 2 && (len(parts[1]) == 1 || len(parts[1]) == 2) {
		return finishMoney(parts[0], parts[1])
	}
	return 0, fmt.Errorf("format angka ambigu: gunakan angka bulat tanpa pemisah atau pemisah ribuan 3 digit")
}

func finishMoney(whole, frac string) (float64, error) {
	if len(whole) > 13 || !digitsOnly.MatchString(whole) {
		return 0, fmt.Errorf("angka terlalu besar")
	}
	text := whole
	if frac != "" {
		text += "." + frac
	}
	v, err := strconv.ParseFloat(text, 64)
	if err != nil || v >= maxMoney {
		return 0, fmt.Errorf("angka terlalu besar")
	}
	return v, nil
}

// ParseDate accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY and checks the real calendar.
// It returns YYYY-MM-DD. US-order and other layouts are errors, never guessed.
func ParseDate(s string) (string, error) {
	s = strings.TrimSpace(s)
	var y, m, d int
	if g := dateISO.FindStringSubmatch(s); g != nil {
		y, m, d = atoi(g[1]), atoi(g[2]), atoi(g[3])
	} else if g := dateDMY.FindStringSubmatch(s); g != nil {
		d, m, y = atoi(g[1]), atoi(g[2]), atoi(g[3])
	} else {
		return "", fmt.Errorf("format tanggal harus YYYY-MM-DD, DD/MM/YYYY atau DD-MM-YYYY")
	}
	if y < minYear || y > maxYear {
		return "", fmt.Errorf("tahun di luar rentang %d-%d", minYear, maxYear)
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Year() != y || int(t.Month()) != m || t.Day() != d {
		return "", fmt.Errorf("tanggal tidak ada di kalender")
	}
	return t.Format("2006-01-02"), nil
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// ParseBool accepts Ya, Tidak, Y, T, true, false, 1, 0 (case-insensitive).
func ParseBool(s string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "ya", "y", "true", "1":
		return true, nil
	case "tidak", "t", "false", "0":
		return false, nil
	}
	return false, fmt.Errorf("nilai harus Ya atau Tidak")
}

// CleanPhone is a format-only clean: spaces, '-', '.', '(' and ')' are removed and a
// leading '+' is kept. There is no +62 to 0 rewrite (the live lookup is exact match).
func CleanPhone(s string) string { return phoneNoise.Replace(strings.TrimSpace(s)) }

// LooksScientific reports a phone that Excel turned into scientific notation (6.28E+11).
func LooksScientific(s string) bool { return scientific.MatchString(strings.TrimSpace(s)) }

// ValidPhone checks a cleaned phone: optional '+', then 6-20 digits.
func ValidPhone(clean string) error {
	if clean == "" {
		return errBlank
	}
	if !phoneShape.MatchString(clean) {
		return fmt.Errorf("telepon harus berisi 6-20 angka (boleh diawali +)")
	}
	return nil
}

// MissingLeadingZero is true for a cleaned phone that starts with neither 0 nor +
// (Excel drops the leading 0 of a numeric cell).
func MissingLeadingZero(clean string) bool {
	return clean != "" && !strings.HasPrefix(clean, "0") && !strings.HasPrefix(clean, "+")
}

// ValidEmail is a deliberately loose shape check (a failure is only a warning).
func ValidEmail(s string) bool { return emailShape.MatchString(s) }

// CheckLen enforces a rune-count cap.
func CheckLen(s string, max int) error {
	if n := utf8.RuneCountInString(s); n > max {
		return fmt.Errorf("terlalu panjang (%d karakter, maksimum %d)", n, max)
	}
	return nil
}
