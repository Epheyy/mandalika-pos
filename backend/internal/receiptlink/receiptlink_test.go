package receiptlink

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type vectors struct {
	Render []struct {
		Name     string `json:"name"`
		Template string `json:"template"`
		Values   struct {
			CustomerName string  `json:"customerName"`
			SalesmanName string  `json:"salesmanName"`
			OutletName   string  `json:"outletName"`
			OrderNumber  string  `json:"orderNumber"`
			Total        float64 `json:"total"`
			Link         string  `json:"link"`
		} `json:"values"`
		Expected string `json:"expected"`
	} `json:"render"`
	Validate []struct {
		Template string `json:"template"`
		OK       bool   `json:"ok"`
	} `json:"validate"`
	Rupiah []struct {
		N        float64 `json:"n"`
		Expected string  `json:"expected"`
	} `json:"rupiah"`
	WaDigits []struct {
		Raw      string `json:"raw"`
		Expected string `json:"expected"`
	} `json:"waDigits"`
	Mask []struct {
		Digits   string `json:"digits"`
		Expected string `json:"expected"`
	} `json:"mask"`
	WaURL []struct {
		Digits   string `json:"digits"`
		Text     string `json:"text"`
		Expected string `json:"expected"`
	} `json:"waUrl"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../packages/types/src/__fixtures__/wa-receipt-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSharedVectors(t *testing.T) {
	v := loadVectors(t)
	if len(v.Render) == 0 || len(v.Validate) == 0 || len(v.Rupiah) == 0 || len(v.WaDigits) == 0 || len(v.Mask) == 0 || len(v.WaURL) == 0 {
		t.Fatal("a vector section is empty")
	}
	for _, c := range v.Render {
		got := Render(c.Template, Values{c.Values.CustomerName, c.Values.SalesmanName, c.Values.OutletName, c.Values.OrderNumber, c.Values.Total, c.Values.Link})
		if got != c.Expected {
			t.Errorf("render %q:\n got %q\nwant %q", c.Name, got, c.Expected)
		}
	}
	for _, c := range v.Validate {
		if msg := Validate(c.Template); (msg == "") != c.OK {
			t.Errorf("validate %.40q: msg=%q want ok=%v", c.Template, msg, c.OK)
		}
	}
	for _, c := range v.Rupiah {
		if got := FormatRupiah(c.N); got != c.Expected {
			t.Errorf("rupiah %v: got %q want %q", c.N, got, c.Expected)
		}
	}
	for _, c := range v.WaDigits {
		if got := WaDigits(c.Raw); got != c.Expected {
			t.Errorf("waDigits %q: got %q want %q", c.Raw, got, c.Expected)
		}
	}
	for _, c := range v.Mask {
		if got := MaskPhone(c.Digits); got != c.Expected {
			t.Errorf("mask %q: got %q want %q", c.Digits, got, c.Expected)
		}
	}
	for _, c := range v.WaURL {
		if got := WaURL(c.Digits, c.Text); got != c.Expected {
			t.Errorf("waUrl: got %q want %q", got, c.Expected)
		}
	}
}

func TestValidateMessages(t *testing.T) {
	cases := map[string]string{
		"":             "Template tidak boleh kosong",
		"Tanpa tautan": "Template wajib memuat {tautan}",
		"{tautan} {x}": "Placeholder {x} tidak dikenal",
	}
	for in, want := range cases {
		if got := Validate(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	if got := Validate("{tautan}" + strings.Repeat("a", 1000)); got != "Template maksimal 1000 karakter" {
		t.Errorf("long: %q", got)
	}
	if Validate(DefaultTemplate) != "" {
		t.Error("the default template must validate")
	}
}

func TestTokenShapeAndHash(t *testing.T) {
	tok, hash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != TokenLen || len(hash) != 32 {
		t.Fatalf("token %q hash len %d", tok, len(hash))
	}
	h2, ok := HashToken(tok)
	if !ok || string(h2) != string(hash) {
		t.Error("HashToken must reproduce the stored hash")
	}
	for _, bad := range []string{"", "short", tok + "x", strings.Repeat("!", 22), strings.Repeat("a", 22) + "\n"} {
		if _, ok := HashToken(bad); ok {
			t.Errorf("%q must not be a token", bad)
		}
	}
	tok2, _, _ := NewToken()
	if tok == tok2 {
		t.Error("tokens must differ")
	}
}

func TestNetHash(t *testing.T) {
	s1, _ := NewSalt()
	s2, _ := NewSalt()
	a, b := NetHash(s1, "1.2.3.4"), NetHash(s1, "1.2.3.4")
	if string(a) != string(b) || len(a) != 32 {
		t.Error("same salt and bucket must match")
	}
	if string(a) == string(NetHash(s1, "1.2.3.5")) || string(a) == string(NetHash(s2, "1.2.3.4")) {
		t.Error("different bucket or salt must differ")
	}
}

func sampleData() PageData {
	stars, tags := FormChoices(0, nil)
	return PageData{
		Brand: "Mandalika <b>BSD</b>", Outlet: "Mandalika BSD", FirstName: "Budi",
		OrderNumber: "BSD-00412", When: FormatWhen(time.Date(2026, 11, 27, 7, 5, 0, 0, time.UTC), time.FixedZone("WIB", 7*3600)),
		Lines:    []Line{{Name: "Oud Royal", Variant: "30 ml", Qty: 1, Subtotal: "Rp 250.000"}, {Name: "Rose Mist", Variant: "10 ml", Qty: 2, Subtotal: "Rp 100.000"}},
		Subtotal: "Rp 350.000", Discount: "-Rp 35.000", Total: "Rp 315.000", Payment: "QRIS",
		PromptTitle: PromptTitle("Rina"), Stars: stars, TagChoices: tags,
	}
}

func TestPageHasNoScriptAndEscapes(t *testing.T) {
	rec := httptest.NewRecorder()
	RenderReceipt(rec, 200, sampleData())
	body := rec.Body.String()
	if strings.Contains(strings.ToLower(body), "<script") {
		t.Error("page must not contain a script")
	}
	if strings.Contains(body, "<b>BSD</b>") || !strings.Contains(body, "&lt;b&gt;BSD&lt;/b&gt;") {
		t.Error("brand must be escaped")
	}
	for _, want := range []string{"Bagaimana pelayanan Rina?", "1 bintang", "5 bintang", "Kirim penilaian", "maxlength=\"500\"", "Halo, Budi", "27 Nov 2026, 14:05"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("public headers missing")
	}
}

func TestRatedStateAndNoSales(t *testing.T) {
	d := sampleData()
	d.Rated, d.RatedStars, d.RatedStarRow, d.RatedTags = true, 4, StarRow(4), []string{"Ramah"}
	d.PromptTitle = PromptTitle("")
	rec := httptest.NewRecorder()
	RenderReceipt(rec, 200, d)
	body := rec.Body.String()
	if !strings.Contains(body, "Terima kasih, penilaian sudah diterima") || !strings.Contains(body, "4 dari 5 bintang") || strings.Contains(body, "Kirim penilaian") {
		t.Error("rated state wrong")
	}
	if PromptTitle("") != "Bagaimana pelayanan kami?" {
		t.Error("no-salesperson prompt")
	}
}

func TestGoneBodyIdentical(t *testing.T) {
	a, b := httptest.NewRecorder(), httptest.NewRecorder()
	RenderGone(a)
	RenderGone(b)
	if a.Code != 404 || a.Body.String() != b.Body.String() || !strings.Contains(a.Body.String(), "Tautan tidak berlaku atau sudah kedaluwarsa") {
		t.Error("gone page")
	}
	if strings.Contains(strings.ToLower(a.Body.String()), "<script") {
		t.Error("gone page has script")
	}
}

// TestWriteSamplePages writes the three pages with sample data into $RECEIPT_PAGE_OUT for a visual
// check (skipped when the variable is unset).
func TestWriteSamplePages(t *testing.T) {
	dir := os.Getenv("RECEIPT_PAGE_OUT")
	if dir == "" {
		t.Skip("RECEIPT_PAGE_OUT not set")
	}
	write := func(name string, rec *httptest.ResponseRecorder) {
		if err := os.WriteFile(dir+"/"+name, rec.Body.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	open := httptest.NewRecorder()
	RenderReceipt(open, 200, sampleData())
	write("receipt-page.html", open)
	d := sampleData()
	d.Rated, d.RatedStars, d.RatedStarRow, d.RatedTags, d.RatedComment = true, 4, StarRow(4), []string{"Ramah", "Cepat"}, "Pelayanannya ramah sekali."
	rated := httptest.NewRecorder()
	RenderReceipt(rated, 200, d)
	write("receipt-page-rated.html", rated)
	gone := httptest.NewRecorder()
	RenderGone(gone)
	write("receipt-gone.html", gone)
}
