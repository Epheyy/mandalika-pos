package receiptlink

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/mandalika/pos-backend/internal/phone"
)

// Placeholders are the names a WhatsApp message template may use.
var Placeholders = []string{"{pelanggan}", "{sales}", "{outlet}", "{no_order}", "{total}", "{tautan}"}

// DefaultTemplate is the built-in message (stored template NULL = this).
const DefaultTemplate = "Halo {pelanggan}, terima kasih sudah berbelanja di {outlet}.\n\nStruk digital pesanan {no_order} (total {total}):\n{tautan}\n\nBagaimana pelayanan {sales} hari ini? Mohon beri penilaian lewat tautan di atas, cukup 10 detik. Tautan berlaku 7 hari."

const (
	TemplateMaxRunes = 1000
	DigitsMin        = 10
	DigitsMax        = 15
)

// Values are the inputs of Render.
type Values struct {
	CustomerName, SalesmanName, OutletName, OrderNumber string
	Total                                               float64
	Link                                                string
}

var placeholderRE = regexp.MustCompile(`\{[a-z_]+\}`)

// isJSSpace matches JavaScript's \s, so the Go and TypeScript twins collapse the same characters.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// clean collapses every whitespace run (newlines included) to one space and trims.
func clean(s string) string {
	return strings.Join(strings.FieldsFunc(s, isJSSpace), " ")
}

// FormatRupiah renders "Rp 150.000": dot-grouped, rounded half away from zero, "-" before "Rp"
// when negative, never "-Rp 0". No locale formatting (it would put a no-break space in).
func FormatRupiah(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		n = 0
	}
	digits := strconv.FormatFloat(math.Round(math.Abs(n)), 'f', 0, 64)
	var b strings.Builder
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	grouped := b.String()
	neg := n < 0 && grouped != "0"
	if neg {
		return "-Rp " + grouped
	}
	return "Rp " + grouped
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// Render fills the template in a single pass: a value that itself contains a placeholder is never
// expanded again, and an unknown {x} stays literal.
func Render(tpl string, v Values) string {
	first, _, _ := strings.Cut(clean(v.CustomerName), " ")
	values := map[string]string{
		"{pelanggan}": orDefault(first, "Kak"),
		"{sales}":     orDefault(clean(v.SalesmanName), "tim kami"),
		"{outlet}":    orDefault(clean(v.OutletName), "-"),
		"{no_order}":  orDefault(clean(v.OrderNumber), "-"),
		"{total}":     FormatRupiah(v.Total),
		"{tautan}":    clean(v.Link),
	}
	return placeholderRE.ReplaceAllStringFunc(tpl, func(m string) string {
		if s, ok := values[m]; ok {
			return s
		}
		return m
	})
}

// Validate returns "" when the template is usable, else a Bahasa Indonesia message.
func Validate(tpl string) string {
	n := utf8.RuneCountInString(tpl)
	if n < 1 {
		return "Template tidak boleh kosong"
	}
	if n > TemplateMaxRunes {
		return fmt.Sprintf("Template maksimal %d karakter", TemplateMaxRunes)
	}
	known := make(map[string]bool, len(Placeholders))
	for _, p := range Placeholders {
		known[p] = true
	}
	for _, m := range placeholderRE.FindAllString(tpl, -1) {
		if !known[m] {
			return "Placeholder " + m + " tidak dikenal"
		}
	}
	if !strings.Contains(tpl, "{tautan}") {
		return "Template wajib memuat {tautan}"
	}
	return ""
}

// WaDigits is the wa.me number: phone.Normalize, a local leading 0 becomes 62; 10-15 digits, else "".
func WaDigits(raw string) string {
	key := phone.Normalize(raw)
	if key == "" {
		return ""
	}
	if strings.HasPrefix(key, "0") {
		key = "62" + key[1:]
	}
	if len(key) < DigitsMin || len(key) > DigitsMax {
		return ""
	}
	return key
}

// MaskPhone keeps only the last four digits: "****1234".
func MaskPhone(digits string) string {
	if len(digits) > 4 {
		digits = digits[len(digits)-4:]
	}
	return "****" + digits
}

// encodeURIComponent escapes like JavaScript's encodeURIComponent: only A-Z a-z 0-9 - _ . ! ~ * ' ( )
// stay literal.
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			strings.IndexByte("-_.!~*'()", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

// WaURL is the click-to-chat link: https://wa.me/<digits>?text=<escaped message>.
func WaURL(digits, text string) string {
	return "https://wa.me/" + digits + "?text=" + encodeURIComponent(text)
}
