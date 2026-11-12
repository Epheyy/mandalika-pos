package service

import (
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/bundles"
)

const ext = "EXTRAIT DE PARFUM"

func champPrices() bundles.Prices {
	return bundles.Prices{
		Standard: map[string]float64{"120ml": 795000, "110ml": 725000},
		Lines:    map[string]map[string]float64{ext: {"120ml": 850000}},
	}
}

func sbPiece(idx int, role bundles.Role, line, size string, client, catalog int64) setBundlePiece {
	return setBundlePiece{
		idx: idx, role: role, classified: true,
		piece:       bundles.Piece{Role: role, Line: line, Size: size},
		clientBasis: client, catalogBasis: catalog,
	}
}

func champGroup(clientPrice float64) setBundleGroup {
	return setBundleGroup{group: 1, clientPrice: clientPrice, pieces: []setBundlePiece{
		sbPiece(0, bundles.RoleLarge, ext, "120ml", 1200000, 1200000),
		sbPiece(1, bundles.RoleAtomizer, "", "10ml", 250000, 250000),
		sbPiece(2, bundles.RoleVial, ext, "2ml", 60000, 60000),
	}}
}

func TestPriceSetBundleValid(t *testing.T) {
	got, warns := priceSetBundle(champGroup(850000), champPrices(), false)
	if !got.ok || len(warns) != 0 {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
	if got.shares != [3]int64{675498, 140728, 33774} || got.line != ext || got.size != "120ml" || got.price != 850000 {
		t.Fatalf("got %+v", got)
	}
}

func TestPriceSetBundleSwapKeepsPrice(t *testing.T) {
	g := champGroup(850000)
	g.pieces[1] = sbPiece(1, bundles.RoleAtomizer, "", "10ml", 300000, 300000)
	got, warns := priceSetBundle(g, champPrices(), false)
	if !got.ok || len(warns) != 0 {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
	if got.price != 850000 || got.shares[0]+got.shares[1]+got.shares[2] != 850000 {
		t.Fatalf("got %+v", got)
	}
}

func TestPriceSetBundleRejects(t *testing.T) {
	cases := map[string]func(g *setBundleGroup){
		"two pieces":    func(g *setBundleGroup) { g.pieces = g.pieces[:2] },
		"two atomizers": func(g *setBundleGroup) { g.pieces[2] = sbPiece(2, bundles.RoleAtomizer, "", "10ml", 1, 1) },
		"PI vial in EXT": func(g *setBundleGroup) {
			g.pieces[2] = sbPiece(2, bundles.RoleVial, "PARFUM INTENSE", "2ml", 60000, 60000)
		},
		"no standard price":  func(g *setBundleGroup) { g.pieces[0] = sbPiece(0, bundles.RoleLarge, ext, "130ml", 1200000, 1200000) },
		"unclassified large": func(g *setBundleGroup) { g.pieces[0].classified = false },
		"role mismatch":      func(g *setBundleGroup) { g.pieces[0].piece.Role = bundles.RoleVial },
		"price mismatch":     func(g *setBundleGroup) { g.mismatch = true },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			g := champGroup(850000)
			mut(&g)
			got, warns := priceSetBundle(g, champPrices(), false)
			if got.ok || !reflect.DeepEqual(warns, []PromoViolation{ViolationBundleInvalid}) {
				t.Fatalf("ok=%v warns=%v", got.ok, warns)
			}
		})
	}
}

func TestPriceSetBundleZeroPricePieceInvalid(t *testing.T) {
	g := champGroup(850000)
	g.pieces[1].classified = false // a 0-priced atomizer is not a piece
	g.pieces[1].clientBasis, g.pieces[1].catalogBasis = 0, 0
	if got, warns := priceSetBundle(g, champPrices(), true); got.ok || warns[0] != ViolationBundleInvalid {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
}

func TestPriceSetBundleInactiveVialInvalid(t *testing.T) {
	g := champGroup(850000)
	g.pieces[2].classified = false
	if got, warns := priceSetBundle(g, champPrices(), false); got.ok || warns[0] != ViolationBundleInvalid {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
}

func TestPriceSetBundleStalePriceOnlineRejects(t *testing.T) {
	got, warns := priceSetBundle(champGroup(795000), champPrices(), false)
	if got.ok || !reflect.DeepEqual(warns, []PromoViolation{ViolationBundlePriceChanged}) {
		t.Fatalf("ok=%v warns=%v", got.ok, warns)
	}
}

func TestPriceSetBundleStalePriceOfflineKeepsClientPrice(t *testing.T) {
	got, warns := priceSetBundle(champGroup(795000), champPrices(), true)
	if !got.ok || got.price != 795000 || !reflect.DeepEqual(warns, []PromoViolation{ViolationBundlePriceChanged}) {
		t.Fatalf("got %+v warns=%v", got, warns)
	}
	want, _ := bundles.Split(795000, [3]int64{1200000, 250000, 60000})
	if got.shares != want {
		t.Fatalf("shares %v want %v", got.shares, want)
	}
}

func TestPriceSetBundleNoLineUsesStandard(t *testing.T) {
	g := setBundleGroup{group: 1, clientPrice: 725000, pieces: []setBundlePiece{
		sbPiece(0, bundles.RoleLarge, "", "110ml", 1000000, 1000000),
		sbPiece(1, bundles.RoleAtomizer, "", "10ml", 250000, 250000),
		sbPiece(2, bundles.RoleVial, "", "2ml", 60000, 60000),
	}}
	p := champPrices()
	p.Lines[ext]["110ml"] = 999999 // a line price must never apply to a no-line bundle
	got, warns := priceSetBundle(g, p, false)
	if !got.ok || got.price != 725000 || len(warns) != 0 {
		t.Fatalf("got %+v warns=%v", got, warns)
	}
}

func TestPriceSetBundleNoClientPriceUsesCatalog(t *testing.T) {
	got, warns := priceSetBundle(champGroup(0), champPrices(), false)
	if !got.ok || got.price != 850000 || len(warns) != 0 {
		t.Fatalf("got %+v warns=%v", got, warns)
	}
}

func TestPriceSetBundleClientBasisPreferred(t *testing.T) {
	g := champGroup(850000)
	g.pieces[0].clientBasis, g.pieces[1].clientBasis, g.pieces[2].clientBasis = 1000000, 200000, 50000
	got, _ := priceSetBundle(g, champPrices(), false)
	want, _ := bundles.Split(850000, [3]int64{1000000, 200000, 50000})
	if !got.ok || got.shares != want {
		t.Fatalf("got %+v want shares %v", got, want)
	}
}

func TestPriceSetBundleShareNeverZero(t *testing.T) {
	bad := func(g *setBundleGroup) {
		g.pieces[0].clientBasis, g.pieces[1].clientBasis, g.pieces[2].clientBasis = 1, 1_000_000_000, 1
	}
	g := champGroup(850000)
	bad(&g)
	if got, w := priceSetBundle(g, champPrices(), false); got.ok || w[0] != ViolationBundleInvalid {
		t.Fatalf("online: ok=%v warns=%v", got.ok, w)
	}
	got, w := priceSetBundle(g, champPrices(), true)
	if !got.ok || got.shares != [3]int64{675498, 140728, 33774} || !reflect.DeepEqual(w, []PromoViolation{ViolationBundleBasisReplaced}) {
		t.Fatalf("offline: %+v warns=%v", got, w)
	}
	// the catalog basis fails too: invalid either way
	for _, off := range []bool{false, true} {
		g2 := champGroup(850000)
		bad(&g2)
		g2.pieces[0].catalogBasis, g2.pieces[1].catalogBasis, g2.pieces[2].catalogBasis = 1, 1_000_000, 1
		if got, w := priceSetBundle(g2, champPrices(), off); got.ok || w[0] != ViolationBundleInvalid {
			t.Fatalf("offline=%v: ok=%v warns=%v", off, got.ok, w)
		}
	}
}
