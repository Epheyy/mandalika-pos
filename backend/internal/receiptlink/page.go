package receiptlink

import (
	"bytes"
	"embed"
	"html/template"
	"net/http"
	"time"
)

//go:embed page.html state.html style.html
var pageFS embed.FS

// Tags are the rating tags, in display order: stored code and label.
var Tags = []struct{ Code, Label string }{
	{"ramah", "Ramah"},
	{"membantu", "Membantu"},
	{"paham_produk", "Paham produk"},
	{"cepat", "Cepat"},
}

// TagLabel is the label of a stored tag code ("" when unknown).
func TagLabel(code string) string {
	for _, t := range Tags {
		if t.Code == code {
			return t.Label
		}
	}
	return ""
}

// Line is one receipt line, already formatted.
type Line struct {
	Name, Variant, Subtotal string
	Qty                     int
}

// AdjRow is one extra money row between the tax and the total (surcharge, points, rounding).
type AdjRow struct{ Label, Amount string }

// TagChoice is one checkbox of the form.
type TagChoice struct {
	Code, Label string
	Checked     bool
}

// StarChoice is one radio of the form, listed 5..1 (the CSS row-reverse puts 1 on the left).
type StarChoice struct {
	Value   int
	Checked bool
}

// PageData is everything the receipt page shows. It carries the first name only, never a phone
// number or a full customer name. Money fields are pre-formatted ("Rp 150.000").
type PageData struct {
	Logo          template.URL // brand logo as a data: URI; "" = none
	Brand, Outlet string
	FirstName     string // greeting; "" = no greeting
	OrderNumber   string
	When          string
	Lines         []Line
	Subtotal      string
	Discount      string // "" = none
	Tax           string // "" = none
	Extras        []AdjRow
	Total         string
	Payment       string

	Rated        bool
	RatedStars   int
	RatedStarRow []bool // 5 entries, true = filled
	RatedTags    []string
	RatedComment string

	Error       string
	PromptTitle string // "Bagaimana pelayanan Rina?" / "Bagaimana pelayanan kami?"
	Stars       []StarChoice
	TagChoices  []TagChoice
	Comment     string
}

var tmpl = template.Must(template.ParseFS(pageFS, "page.html", "state.html", "style.html"))

var idMonths = [...]string{"Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"}

// FormatWhen renders "27 Nov 2026, 14:05" in the given zone (the outlet's).
func FormatWhen(t time.Time, loc *time.Location) string {
	if loc == nil {
		loc = time.UTC
	}
	t = t.In(loc)
	return t.Format("2") + " " + idMonths[t.Month()-1] + " " + t.Format("2006, 15:04")
}

// PromptTitle is the heading of the rating card.
func PromptTitle(salesman string) string {
	if salesman == "" {
		return "Bagaimana pelayanan kami?"
	}
	return "Bagaimana pelayanan " + salesman + "?"
}

// FormChoices builds the form state: the selected star (0 = none) and the checked tag codes.
func FormChoices(star int, checked []string) (stars []StarChoice, tags []TagChoice) {
	for v := 5; v >= 1; v-- {
		stars = append(stars, StarChoice{Value: v, Checked: v == star})
	}
	on := make(map[string]bool, len(checked))
	for _, c := range checked {
		on[c] = true
	}
	for _, t := range Tags {
		tags = append(tags, TagChoice{Code: t.Code, Label: t.Label, Checked: on[t.Code]})
	}
	return stars, tags
}

// StarRow is the 5 filled/empty flags of a rating.
func StarRow(stars int) []bool {
	row := make([]bool, 5)
	for i := range row {
		row[i] = i < stars
	}
	return row
}

// SetPublicHeaders sets the headers every /r/{token} response carries (HTML, no caching, no
// referrer, closed CSP: one inline <style>, no script, no external resource).
func SetPublicHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("X-Content-Type-Options", "nosniff")
}

// render executes the named template into a buffer first, so a template error never leaves a
// half-written page behind.
func render(w http.ResponseWriter, status int, name string, data any) {
	var buf bytes.Buffer
	if err := tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		SetPublicHeaders(w)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>Kesalahan</title><p>Halaman belum dapat ditampilkan.</p>"))
		return
	}
	SetPublicHeaders(w)
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

// RenderReceipt writes the receipt page with the given status (200, or 400 for a form error).
func RenderReceipt(w http.ResponseWriter, status int, d PageData) {
	render(w, status, "page.html", d)
}

// StateData is the shared one-panel page of the 404, 429 and 503 states.
type StateData struct {
	Logo                               template.URL
	Title, Mark, Heading, Body, Action string
}

func renderState(w http.ResponseWriter, status int, d StateData) {
	render(w, status, "state.html", d)
}

// RenderGone writes the one body used for an unknown, expired or malformed link (404). The body
// depends only on logo, never on why the link is gone.
func RenderGone(w http.ResponseWriter, logo template.URL) {
	renderState(w, http.StatusNotFound, StateData{
		Logo: logo, Title: "Tautan tidak berlaku", Mark: "!",
		Heading: "Tautan tidak berlaku atau sudah kedaluwarsa",
		Body:    "Silakan hubungi outlet tempat Anda berbelanja untuk meminta tautan baru.",
	})
}

// RenderRateLimited writes the 429 page of the public routes.
func RenderRateLimited(w http.ResponseWriter, logo template.URL) {
	renderState(w, http.StatusTooManyRequests, StateData{
		Logo: logo, Title: "Terlalu banyak permintaan", Mark: "⌛",
		Heading: "Terlalu banyak permintaan",
		Body:    "Tunggu sekitar satu menit, lalu buka lagi halaman ini.", Action: "Muat ulang",
	})
}

// RenderUnavailable writes a plain 503 page for a database failure on the public routes, so the
// page never leaks an error text.
func RenderUnavailable(w http.ResponseWriter, logo template.URL) {
	w.Header().Set("Retry-After", "5")
	renderState(w, http.StatusServiceUnavailable, StateData{
		Logo: logo, Title: "Coba lagi", Mark: "↻",
		Heading: "Halaman belum dapat ditampilkan",
		Body:    "Coba lagi sebentar lagi.", Action: "Muat ulang",
	})
}
