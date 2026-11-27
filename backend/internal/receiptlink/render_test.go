package receiptlink

import (
	"html/template"
	"net/http/httptest"
	"strings"
	"testing"
)

const testLogo = template.URL("data:image/png;base64,iVBORw0KGgo=")

func TestPageLogo(t *testing.T) {
	with := sampleData()
	with.Logo = testLogo
	rec := httptest.NewRecorder()
	RenderReceipt(rec, 200, with)
	body := rec.Body.String()
	if !strings.Contains(body, `<img class="logo" src="data:image/png;base64,`) {
		t.Error("logo img missing")
	}
	if strings.Contains(body, "ZgotmplZ") {
		t.Error("data URI was rewritten to #ZgotmplZ")
	}
	rec = httptest.NewRecorder()
	RenderReceipt(rec, 200, sampleData())
	if strings.Contains(rec.Body.String(), "<img") {
		t.Error("no logo, no img")
	}
}

func TestKeptStringsAndFields(t *testing.T) {
	d := sampleData()
	d.Error = "Pilih jumlah bintang terlebih dahulu."
	rec := httptest.NewRecorder()
	RenderReceipt(rec, 400, d)
	body := rec.Body.String()
	for _, want := range []string{
		"Struk digital", "Outlet", "Waktu", "Pesanan", "Subtotal", "Diskon", "Total", "Pembayaran:",
		"Beri bintang", "Apa yang berkesan? (boleh dikosongkan)", "Komentar (boleh dikosongkan)",
		"Tautan ini khusus untuk pesanan Anda.", `name="stars"`, `name="tags"`, `name="comment"`,
		`id="s5"`, `id="t-paham_produk"`, ` required`, `role="alert"`, d.Error,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	if rec.Code != 400 {
		t.Errorf("status %d", rec.Code)
	}
}

func TestStatePages(t *testing.T) {
	for _, logo := range []template.URL{"", testLogo} {
		a, b := httptest.NewRecorder(), httptest.NewRecorder()
		RenderGone(a, logo)
		RenderGone(b, logo)
		if a.Code != 404 || a.Body.String() != b.Body.String() {
			t.Errorf("404 must be byte-identical (logo %q)", logo)
		}
		for name, rec := range map[string]*httptest.ResponseRecorder{"404": a} {
			if strings.Contains(rec.Body.String(), "ZgotmplZ") || strings.Contains(strings.ToLower(rec.Body.String()), "<script") {
				t.Errorf("%s page bad", name)
			}
		}
		if (logo != "") != strings.Contains(a.Body.String(), "<img") {
			t.Error("logo presence")
		}
	}
	lim := httptest.NewRecorder()
	RenderRateLimited(lim, testLogo)
	if lim.Code != 429 || !strings.Contains(lim.Body.String(), "Terlalu banyak permintaan") ||
		!strings.Contains(lim.Body.String(), "Tunggu sekitar satu menit, lalu buka lagi halaman ini.") ||
		!strings.Contains(lim.Body.String(), `class="btn" href=""`) {
		t.Error("429 page")
	}
	un := httptest.NewRecorder()
	RenderUnavailable(un, "")
	if un.Code != 503 || un.Header().Get("Retry-After") != "5" || !strings.Contains(un.Body.String(), "Halaman belum dapat ditampilkan") ||
		!strings.Contains(un.Body.String(), "Coba lagi sebentar lagi.") {
		t.Error("503 page")
	}
	for _, rec := range []*httptest.ResponseRecorder{lim, un} {
		h := rec.Header()
		if h.Get("Cache-Control") != "no-store" || !strings.Contains(h.Get("Content-Security-Policy"), "img-src 'self' data:") {
			t.Error("public headers missing")
		}
	}
}
