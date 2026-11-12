package bundles

import (
	"reflect"
	"testing"
)

const (
	ext = "EXT"
	pi  = "PERFUME INTENSE"
)

func lv(pid, name, label, cat string, price float64) Variant {
	return Variant{ProductID: pid, ProductName: name, Label: label, ErpCategory: cat, ErpLinked: true, Price: price, Active: true}
}

func uv(pid, name, label string, price float64) Variant {
	return Variant{ProductID: pid, ProductName: name, Label: label, Price: price, Active: true}
}

func stdPrices() Prices {
	return Prices{
		Standard: map[string]float64{"100ml": 650000, "110ml": 725000, "120ml": 795000},
		Lines:    map[string]map[string]float64{"EXTRAIT DE PARFUM": {"120ml": 850000}},
	}
}

func champion() []Variant {
	return []Variant{
		lv("c", "CHAMPION", "120ml EXTRAIT DE PARFUM", ext, 1200000),
		lv("c", "CHAMPION", "120ml PARFUM INTENSE", pi, 1100000),
		lv("c", "CHAMPION", "10ml ATOMIZER", "ATOMIZER", 250000),
		lv("c", "CHAMPION", "2ml EXTRAIT DE PARFUM", ext, 60000),
		lv("c", "CHAMPION", "2ml PARFUM INTENSE", pi, 55000),
	}
}

func TestParseSizeML(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"120ml EXTRAIT DE PARFUM", "120ml", true},
		{"110ml", "110ml", true},
		{"10ml ATOMIZER", "10ml", true},
		{" 2 ML", "2ml", true},
		{"Satuan", "", false},
		{"ml", "", false},
		{"", "", false},
		{"0ml", "", false},
	}
	for _, c := range cases {
		got, ok := ParseSizeML(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseSizeML(%q) = %q,%v want %q,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestClassify(t *testing.T) {
	p := stdPrices()
	type want struct {
		ok   bool
		role Role
		line string
		size string
	}
	inactive := lv("x", "X", "120ml EXTRAIT DE PARFUM", ext, 1)
	inactive.Active = false
	cases := []struct {
		name string
		v    Variant
		w    want
	}{
		{"large ext", lv("x", "X", "120ml EXTRAIT DE PARFUM", ext, 1200000), want{true, RoleLarge, "EXTRAIT DE PARFUM", "120ml"}},
		{"vial pi", lv("x", "X", "2ml PARFUM INTENSE", pi, 55000), want{true, RoleVial, "PARFUM INTENSE", "2ml"}},
		{"atomizer", lv("x", "X", "10ml ATOMIZER", "ATOMIZER", 250000), want{true, RoleAtomizer, "", "10ml"}},
		{"category spacing and case", lv("x", "X", "100ml", "  perfume   intense ", 1000), want{true, RoleLarge, "PARFUM INTENSE", "100ml"}},
		{"tester", lv("x", "X", "120ml", "DISPLAY EXT", 1000), want{ok: false}},
		{"hampers", lv("x", "X", "120ml", "HAMPERS EXT", 1000), want{ok: false}},
		{"glitter 100ml", lv("x", "X", "100ml", "GLITTER", 1000), want{ok: false}},
		{"15ml ext", lv("x", "X", "15ml EXTRAIT DE PARFUM", ext, 1000), want{ok: false}},
		{"130ml without standard price", lv("x", "X", "130ml", ext, 1000), want{ok: false}},
		{"price zero", lv("x", "X", "120ml", ext, 0), want{ok: false}},
		{"inactive", inactive, want{ok: false}},
		{"atomizer category with wrong size", lv("x", "X", "15ml", "ATOMIZER", 1000), want{ok: false}},
		{"unlinked 110ml", uv("x", "X", "110ml", 1000), want{true, RoleLarge, "", "110ml"}},
		{"unlinked 10ml", uv("x", "X", "10ml", 1000), want{true, RoleAtomizer, "", "10ml"}},
		{"unlinked 2ml", uv("x", "X", "2ml", 1000), want{true, RoleVial, "", "2ml"}},
		{"unlinked satuan", uv("x", "X", "Satuan", 1000), want{ok: false}},
		{"linked blank category large", lv("x", "X", "120ml EXTRAIT DE PARFUM", "", 1000), want{ok: false}},
		{"linked blank category 10ml", lv("x", "X", "10ml", "", 1000), want{ok: false}},
		{"linked blank category 2ml", lv("x", "X", "2ml", "", 1000), want{ok: false}},
	}
	for _, c := range cases {
		got, ok := Classify(c.v, p)
		if ok != c.w.ok {
			t.Errorf("%s: ok = %v want %v", c.name, ok, c.w.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.Role != c.w.role || got.Line != c.w.line || got.Size != c.w.size || got.VariantSize != c.v.Label || got.ProductID != c.v.ProductID {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
}

func TestPricesPriceFor(t *testing.T) {
	p := stdPrices()
	if got, ok := p.PriceFor("EXTRAIT DE PARFUM", "120ml"); !ok || got != 850000 {
		t.Fatalf("line price: %v %v", got, ok)
	}
	if got, ok := p.PriceFor("PARFUM INTENSE", "120ml"); !ok || got != 795000 {
		t.Fatalf("standard fallback: %v %v", got, ok)
	}
	if got, ok := p.PriceFor("", "110ml"); !ok || got != 725000 {
		t.Fatalf("no line: %v %v", got, ok)
	}
	if _, ok := p.PriceFor("EXTRAIT DE PARFUM", "130ml"); ok {
		t.Fatal("130ml has no standard price")
	}
	if got := p.LargeSizes(); !reflect.DeepEqual(got, []string{"100ml", "110ml", "120ml"}) {
		t.Fatalf("LargeSizes = %v", got)
	}
}

func TestDeriveChampion(t *testing.T) {
	cat := Derive(champion(), stdPrices())
	if len(cat.Products) != 1 {
		t.Fatalf("products = %+v", cat.Products)
	}
	pb := cat.Products[0]
	want := []Offer{
		{Line: "EXTRAIT DE PARFUM", Size: "120ml", Price: 850000, LargeSize: "120ml EXTRAIT DE PARFUM", AtomizerSize: "10ml ATOMIZER", VialSize: "2ml EXTRAIT DE PARFUM"},
		{Line: "PARFUM INTENSE", Size: "120ml", Price: 795000, LargeSize: "120ml PARFUM INTENSE", AtomizerSize: "10ml ATOMIZER", VialSize: "2ml PARFUM INTENSE"},
	}
	if !reflect.DeepEqual(pb.Offers, want) {
		t.Fatalf("offers = %+v", pb.Offers)
	}
	if len(pb.Missing) != 0 {
		t.Fatalf("missing = %+v", pb.Missing)
	}
	if !reflect.DeepEqual(cat.Lines, []string{"EXTRAIT DE PARFUM", "PARFUM INTENSE"}) {
		t.Fatalf("lines = %v", cat.Lines)
	}
}

func TestDerive24HoursFourOffers(t *testing.T) {
	vs := []Variant{
		lv("h", "24HOURS", "120ml PARFUM INTENSE", pi, 1),
		lv("h", "24HOURS", "100ml EXTRAIT DE PARFUM", ext, 1),
		lv("h", "24HOURS", "120ml EXTRAIT DE PARFUM", ext, 1),
		lv("h", "24HOURS", "100ml PARFUM INTENSE", pi, 1),
		lv("h", "24HOURS", "10ml ATOMIZER", "ATOMIZER", 1),
		lv("h", "24HOURS", "2ml EXTRAIT DE PARFUM", ext, 1),
		lv("h", "24HOURS", "2ml PARFUM INTENSE", pi, 1),
	}
	cat := Derive(vs, stdPrices())
	var got [][2]string
	for _, o := range cat.Products[0].Offers {
		_, short := LineInfo(o.Line)
		got = append(got, [2]string{short, o.Size})
	}
	want := [][2]string{{"EXT", "100ml"}, {"PI", "100ml"}, {"EXT", "120ml"}, {"PI", "120ml"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v", got)
	}
}

func TestDeriveMissingReasons(t *testing.T) {
	vs := []Variant{
		lv("a", "AAA", "120ml EXTRAIT DE PARFUM", ext, 1),
		lv("a", "AAA", "120ml PARFUM INTENSE", pi, 1),
		lv("a", "AAA", "10ml ATOMIZER", "ATOMIZER", 1),
		lv("a", "AAA", "2ml EXTRAIT DE PARFUM", ext, 1),
	}
	pb := Derive(vs, stdPrices()).Products[0]
	if len(pb.Offers) != 1 || pb.Offers[0].Line != "EXTRAIT DE PARFUM" {
		t.Fatalf("offers = %+v", pb.Offers)
	}
	wantM := []Missing{{"PARFUM INTENSE", "120ml", "no_vial", "2ml Parfum Intense belum ada"}}
	if !reflect.DeepEqual(pb.Missing, wantM) {
		t.Fatalf("missing = %+v", pb.Missing)
	}

	noAtom := vs[:1:1]
	noAtom = append(noAtom, vs[1], vs[3])
	pb = Derive(noAtom, stdPrices()).Products[0]
	if len(pb.Offers) != 0 || len(pb.Missing) != 2 {
		t.Fatalf("no atomizer: %+v", pb)
	}
	for _, m := range pb.Missing {
		if m.Reason != "no_atomizer" || m.Text != "atomizer belum ada" {
			t.Fatalf("missing = %+v", m)
		}
	}
}

func TestDeriveUpgrade110To120(t *testing.T) {
	vs := []Variant{
		lv("u", "UP", "110ml EXTRAIT DE PARFUM", ext, 1),
		lv("u", "UP", "120ml EXTRAIT DE PARFUM", ext, 1),
		lv("u", "UP", "10ml ATOMIZER", "ATOMIZER", 1),
		lv("u", "UP", "2ml EXTRAIT DE PARFUM", ext, 1),
	}
	offers := Derive(vs, stdPrices()).Products[0].Offers
	if len(offers) != 2 || offers[0].Size != "110ml" || offers[1].Size != "120ml" {
		t.Fatalf("offers = %+v", offers)
	}
	if offers[0].Price != 725000 || offers[1].Price != 850000 {
		t.Fatalf("prices = %v %v", offers[0].Price, offers[1].Price)
	}
}

func TestDeriveTestCatalogNoErp(t *testing.T) {
	p := stdPrices()
	p.Lines = map[string]map[string]float64{"EXTRAIT DE PARFUM": {"110ml": 999000}}
	vs := []Variant{uv("t", "TEST", "110ml", 1), uv("t", "TEST", "10ml", 1), uv("t", "TEST", "2ml", 1)}
	cat := Derive(vs, p)
	want := []Offer{{Line: "", Size: "110ml", Price: 725000, LargeSize: "110ml", AtomizerSize: "10ml", VialSize: "2ml"}}
	if !reflect.DeepEqual(cat.Products[0].Offers, want) {
		t.Fatalf("offers = %+v", cat.Products[0].Offers)
	}
	if len(cat.Lines) != 0 {
		t.Fatalf("a no-line bundle must not add a line: %v", cat.Lines)
	}
}

func TestDeriveDropsOfferWhenVialInactive(t *testing.T) {
	vs := champion()
	vs[3].Active = false
	pb := Derive(vs, stdPrices()).Products[0]
	if len(pb.Offers) != 1 || pb.Offers[0].Line != "PARFUM INTENSE" {
		t.Fatalf("offers = %+v", pb.Offers)
	}
	if len(pb.Missing) != 1 || pb.Missing[0].Reason != "no_vial" {
		t.Fatalf("missing = %+v", pb.Missing)
	}
}

func TestPiecesListEveryClassifiedVariant(t *testing.T) {
	vs := append(champion(), lv("c", "CHAMPION", "120ml", "DISPLAY EXT", 1))
	cat := Derive(vs, stdPrices())
	if len(cat.Pieces) != 5 {
		t.Fatalf("pieces = %+v", cat.Pieces)
	}
	seen := map[string]Piece{}
	for _, pc := range cat.Pieces {
		if _, dup := seen[pc.VariantSize]; dup {
			t.Fatalf("duplicate piece %s", pc.VariantSize)
		}
		seen[pc.VariantSize] = pc
	}
	if pc := seen["10ml ATOMIZER"]; pc.Role != RoleAtomizer || pc.Line != "" {
		t.Fatalf("atomizer = %+v", pc)
	}
	if pc := seen["2ml PARFUM INTENSE"]; pc.Role != RoleVial || pc.Line != "PARFUM INTENSE" {
		t.Fatalf("vial = %+v", pc)
	}
}

func TestDeriveSkipsProductWithoutLarge(t *testing.T) {
	vs := []Variant{lv("z", "ZED", "10ml ATOMIZER", "ATOMIZER", 1), lv("z", "ZED", "2ml EXTRAIT DE PARFUM", ext, 1)}
	if cat := Derive(vs, stdPrices()); len(cat.Products) != 0 {
		t.Fatalf("products = %+v", cat.Products)
	}
}
