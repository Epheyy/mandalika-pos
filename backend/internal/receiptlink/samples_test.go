package receiptlink

import (
	"html/template"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// samplePNG is a small valid 2x2 PNG used as the sample logo.
const samplePNG = template.URL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4z8DAwMDEAAUAGgcBAj6s1WQAAAAASUVORK5CYII=")

func mockData(logo template.URL) PageData {
	stars, tags := FormChoices(0, nil)
	return PageData{
		Logo: logo, Brand: "MANDALIKA AEON BSD", Outlet: "MANDALIKA AEON BSD", FirstName: "Rina",
		OrderNumber: "BSD-AA0004", Salesman: "Anggun", When: "27 Nov 2026, 12:17",
		Lines: []Line{
			{Name: "Aurora Eau de Parfum", Variant: "50 ml", Qty: 1, Subtotal: "Rp 285.000"},
			{Name: "Sakura Body Mist", Variant: "100 ml", Qty: 2, Subtotal: "Rp 150.000"},
		},
		Subtotal: "Rp 435.000", Discount: "-Rp 43.500", Total: "Rp 391.500", Payment: "QRIS",
		PromptTitle: PromptTitle("Anggun"), Stars: stars, TagChoices: tags,
	}
}

// TestWriteSamplePages writes every page state into $RECEIPT_PAGE_OUT for a side-by-side visual
// check against the mock (skipped when the variable is unset).
func TestWriteSamplePages(t *testing.T) {
	dir := os.Getenv("RECEIPT_PAGE_OUT")
	if dir == "" {
		t.Skip("RECEIPT_PAGE_OUT not set")
	}
	write := func(name string, rec *httptest.ResponseRecorder) {
		if err := os.WriteFile(filepath.Join(dir, name), rec.Body.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	receipt := func(status int, d PageData) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		RenderReceipt(rec, status, d)
		return rec
	}
	write("1-form.html", receipt(200, mockData(samplePNG)))
	write("1b-form-nologo.html", receipt(200, mockData("")))
	noSales := mockData(samplePNG)
	noSales.Salesman = ""
	write("1c-form-nosales.html", receipt(200, noSales))

	bad := mockData(samplePNG)
	bad.Stars, bad.TagChoices = FormChoices(0, []string{"ramah", "paham_produk"})
	bad.Comment, bad.Error = "Wanginya pas.", "Pilih jumlah bintang terlebih dahulu."
	write("2-error.html", receipt(400, bad))

	thanks := mockData(samplePNG)
	thanks.Rated, thanks.RatedStars, thanks.RatedStarRow = true, 5, StarRow(5)
	thanks.RatedTags = []string{"Ramah", "Membantu", "Paham produk", "Cepat"}
	thanks.RatedComment = "Mbak Anggun sabar sekali menjelaskan, wanginya pas."
	write("3-thanks.html", receipt(200, thanks))

	state := func(f func(w *httptest.ResponseRecorder, logo template.URL), logo template.URL) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		f(rec, logo)
		return rec
	}
	gone := func(w *httptest.ResponseRecorder, l template.URL) { RenderGone(w, l) }
	limited := func(w *httptest.ResponseRecorder, l template.URL) { RenderRateLimited(w, l) }
	unavailable := func(w *httptest.ResponseRecorder, l template.URL) { RenderUnavailable(w, l) }
	write("4-gone.html", state(gone, samplePNG))
	write("4b-gone-nologo.html", state(gone, ""))
	write("5-ratelimited.html", state(limited, samplePNG))
	write("6-unavailable.html", state(unavailable, samplePNG))
}
