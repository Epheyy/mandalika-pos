// Package receipttpl validates receipt templates. It is the Go twin of validateTemplate in
// packages/printer/src/receipt/validate.ts: the two share testdata/cases.json and must agree on
// validity and on the first issue's code. Keep the check order and the limits in step.
package receipttpl

import (
	"encoding/base64"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mandalika/pos-backend/internal/api"
)

// Limits mirror RECEIPT_LIMITS in packages/printer/src/receipt/validate.ts.
const (
	BlocksMin    = 3
	BlocksMax    = 30
	NameMax      = 60
	TextMax      = 500
	TextLinesMax = 12
	TotalTextMax = 1500
	TitleMax     = 64
	LabelMax     = 40
	IDMax        = 64
	TemplatesMax = 50

	ImageBlocksMax = 2
	ImageBytesMax  = 11520
	QRBlocksMax    = 2
	URLMax         = 300
	RasterMaxWidth = 384
	RasterMaxHigh  = 240
)

var qrURL = regexp.MustCompile(`^https?://[!-~]+$`)

// rasterBytes is what a raster must decode to; 0 when the geometry is unusable.
func rasterBytes(r *api.ReceiptRaster) int {
	if r == nil || r.Width < 8 || r.Width%8 != 0 || r.Height < 1 {
		return 0
	}
	return r.Width / 8 * r.Height
}

// Error is a template refusal: a stable Code and the Indonesian message the Backoffice shows.
type Error struct {
	Code    string
	Message string
	BlockID string
}

func (e *Error) Error() string { return e.Message }

var knownTypes = map[api.ReceiptBlockType]bool{
	api.Header: true, api.Transaction: true, api.Items: true, api.Totals: true,
	api.Payment: true, api.Points: true, api.Text: true, api.Divider: true, api.Image: true, api.Qr: true,
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

// jsSpace matches what JavaScript's String.trim removes, so both validators trim the same set.
func jsSpace(r rune) bool {
	switch r {
	case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// TrimName trims a template name the way the Backoffice does.
func TrimName(s string) string { return strings.TrimFunc(s, jsSpace) }

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
	if n := runes(TrimName(name)); n < 1 || n > NameMax {
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
	// 4b. image and QR counts
	images, qrs, imgBytes := 0, 0, 0
	for _, b := range blocks {
		switch b.Type {
		case api.Image:
			images++
			imgBytes += rasterBytes(b.Image)
		case api.Qr:
			qrs++
		}
	}
	if images > ImageBlocksMax {
		add("too_many_images", "Maksimal 2 blok logo.", "")
	}
	if imgBytes > ImageBytesMax {
		add("images_too_large", "Ukuran logo terlalu besar.", "")
	}
	if qrs > QRBlocksMax {
		add("too_many_qr", "Maksimal 2 blok QR.", "")
	}
	// 5. per block
	seen := make(map[string]bool, len(blocks))
	for _, b := range blocks {
		if b.Id == "" || runes(b.Id) > IDMax {
			add("bad_id", "Setiap blok harus punya id 1-64 karakter.", b.Id)
		} else if seen[b.Id] {
			add("bad_id", "Id blok harus unik.", b.Id)
		}
		seen[b.Id] = true
		if !knownTypes[b.Type] {
			add("unknown_type", `Jenis blok "`+string(b.Type)+`" tidak dikenal.`, b.Id)
			continue
		}
		t := deref(b.Text)
		if b.Align != nil && !b.Align.Valid() {
			add("bad_enum", "Perataan tidak dikenal.", b.Id)
		}
		if b.Size != nil && !b.Size.Valid() {
			add("bad_enum", "Ukuran teks tidak dikenal.", b.Id)
		}
		if b.Style != nil && !b.Style.Valid() {
			add("bad_enum", "Gaya baris tidak dikenal.", b.Id)
		}
		if b.Fields != nil {
			for _, f := range *b.Fields {
				if !f.Valid() {
					add("bad_enum", "Kolom transaksi tidak dikenal.", b.Id)
					break
				}
			}
		}
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
		case api.Image:
			switch r := b.Image; {
			case r == nil:
				add("image_invalid", "Gambar logo tidak ada.", b.Id)
			case r.Width > RasterMaxWidth:
				add("image_too_wide", "Lebar logo maksimal 384 titik.", b.Id)
			case r.Height > RasterMaxHigh:
				add("image_too_tall", "Tinggi logo maksimal 240 titik.", b.Id)
			default:
				if dec, err := base64.StdEncoding.Strict().DecodeString(r.Data); err != nil || strings.ContainsAny(r.Data, "\r\n") || rasterBytes(r) == 0 || len(dec) != rasterBytes(r) {
					add("image_invalid", "Gambar logo rusak.", b.Id)
				}
			}
			if b.Label != nil && runes(*b.Label) > LabelMax {
				add("label_too_long", "Label maksimal 40 karakter.", b.Id)
			}
		case api.Qr:
			if u := deref(b.Url); runes(u) > URLMax {
				add("url_too_long", "Alamat QR maksimal 300 karakter.", b.Id)
			} else if !qrURL.MatchString(u) {
				add("url_invalid", "Alamat QR harus diawali http:// atau https:// dan hanya berisi karakter ASCII.", b.Id)
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
