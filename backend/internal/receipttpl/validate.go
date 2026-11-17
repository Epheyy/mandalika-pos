// Package receipttpl validates receipt templates. It is the Go twin of validateTemplate in
// packages/printer/src/receipt/validate.ts: the two share testdata/cases.json and must agree on
// validity and on the first issue's code. Keep the check order and the limits in step.
package receipttpl

import (
	"strings"
	"unicode/utf8"

	"github.com/mandalika/pos-backend/internal/api"
)

// Limits mirror RECEIPT_LIMITS in packages/printer/src/receipt/validate.ts.
const (
	BlocksMin     = 3
	BlocksMax     = 30
	NameMax       = 60
	TextMax       = 500
	TextLinesMax  = 12
	TotalTextMax  = 1500
	TitleMax      = 64
	LabelMax      = 40
	TemplatesMax  = 50
)

// Error is a template refusal: a stable Code and the Indonesian message the Backoffice shows.
type Error struct {
	Code    string
	Message string
	BlockID string
}

func (e *Error) Error() string { return e.Message }

var knownTypes = map[api.ReceiptBlockType]bool{
	api.Header: true, api.Transaction: true, api.Items: true, api.Totals: true,
	api.Payment: true, api.Points: true, api.Text: true, api.Divider: true,
}

// lockedTypes appear exactly once, enabled, in this relative order.
var lockedTypes = []api.ReceiptBlockType{api.Items, api.Totals, api.Payment}

func isLocked(t api.ReceiptBlockType) bool {
	for _, l := range lockedTypes {
		if t == l {
			return true
		}
	}
	return false
}

func runes(s string) int { return utf8.RuneCountInString(s) }

func printable(s string, allowNewline bool) bool {
	for _, r := range s {
		if r == '\n' && allowNewline {
			continue
		}
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Issues lists every problem with a template body: template-level checks first, then each block in
// list order. Issues(...)[0] is what Validate returns.
func Issues(name string, paperWidth int, blocks []api.ReceiptBlock) []*Error {
	var out []*Error
	add := func(code, msg, blockID string) { out = append(out, &Error{Code: code, Message: msg, BlockID: blockID}) }

	// 1. name and paper width
	if n := runes(strings.TrimSpace(name)); n < 1 || n > NameMax {
		add("name_invalid", "Nama template harus 1-60 karakter.", "")
	}
	if paperWidth != 58 && paperWidth != 80 {
		add("paper_width_invalid", "Lebar kertas harus 58mm atau 80mm.", "")
	}
	// 2. block count
	if len(blocks) < BlocksMin {
		add("too_few_blocks", "Template minimal 3 blok.", "")
	}
	if len(blocks) > BlocksMax {
		add("too_many_blocks", "Template maksimal 30 blok.", "")
	}
	// 3. locked blocks: missing, disabled, order
	for _, t := range lockedTypes {
		found := false
		for _, b := range blocks {
			if b.Type == t {
				found = true
			}
		}
		if !found {
			add("locked_missing", `Blok "`+string(t)+`" wajib ada.`, "")
		}
	}
	for _, b := range blocks {
		if isLocked(b.Type) && !b.Enabled {
			add("locked_disabled", `Blok "`+string(b.Type)+`" tidak bisa dimatikan.`, b.Id)
		}
	}
	prev, ordered := -1, true
	for _, t := range lockedTypes {
		idx := -1
		for i, b := range blocks {
			if b.Type == t {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		if prev >= 0 && idx < prev {
			ordered = false
		}
		prev = idx
	}
	if !ordered {
		add("locked_order", "Urutan blok wajib: Daftar barang, lalu Diskon & total, lalu Pembayaran.", "")
	}
	for _, t := range lockedTypes {
		n := 0
		for _, b := range blocks {
			if b.Type == t {
				n++
			}
		}
		if n > 1 {
			add("locked_order", `Blok "`+string(t)+`" hanya boleh ada satu.`, "")
		}
	}
	// 4. total text
	total := 0
	for _, b := range blocks {
		if b.Type == api.Text || b.Type == api.Header {
			total += runes(deref(b.Text))
		}
	}
	if total > TotalTextMax {
		add("total_text_too_long", "Total teks maksimal 1500 karakter.", "")
	}
	// 5. per block
	for _, b := range blocks {
		if !knownTypes[b.Type] {
			add("unknown_type", `Jenis blok "`+string(b.Type)+`" tidak dikenal.`, b.Id)
			continue
		}
		t := deref(b.Text)
		switch b.Type {
		case api.Header:
			if runes(t) > TitleMax {
				add("title_too_long", "Judul maksimal 64 karakter.", b.Id)
			}
			if !printable(t, false) {
				add("not_printable", "Teks hanya boleh karakter ASCII yang bisa dicetak.", b.Id)
			}
		case api.Text:
			if runes(t) > TextMax {
				add("text_too_long", "Teks maksimal 500 karakter.", b.Id)
			}
			if strings.Count(t, "\n")+1 > TextLinesMax {
				add("too_many_lines", "Teks maksimal 12 baris.", b.Id)
			}
			if !printable(t, true) {
				add("not_printable", "Teks hanya boleh karakter ASCII yang bisa dicetak.", b.Id)
			}
			if b.Label != nil && runes(*b.Label) > LabelMax {
				add("label_too_long", "Label maksimal 40 karakter.", b.Id)
			}
		}
	}
	return out
}

// Validate returns the first issue as an *Error, or nil.
func Validate(name string, paperWidth int, blocks []api.ReceiptBlock) error {
	if is := Issues(name, paperWidth, blocks); len(is) > 0 {
		return is[0]
	}
	return nil
}
