package bundles

import "sort"

// Offer is one bundle a product can be sold as. The *Size fields are variant labels
// inside the same product.
type Offer struct {
	Line, Size                        string
	Price                             float64
	LargeSize, AtomizerSize, VialSize string
}

// Missing explains why a large bottle has no bundle.
type Missing struct{ Line, Size, Reason, Text string }

// ProductBundles is one product's offers and the reasons for the bundles it lacks.
type ProductBundles struct {
	ProductID, ProductName string
	Offers                 []Offer
	Missing                []Missing
}

// Catalog is the derived bundle catalog. Lines lists the distinct non-empty lines of large
// pieces; Pieces lists every classified variant once.
type Catalog struct {
	Lines    []string
	Products []ProductBundles
	Pieces   []Piece
}

func missingText(reason, line string) string {
	if reason == "no_atomizer" {
		return "atomizer belum ada"
	}
	if label, _ := LineInfo(line); label != "" {
		return "2ml " + label + " belum ada"
	}
	return "2ml belum ada"
}

func shortOf(line string) string {
	_, short := LineInfo(line)
	return short
}

func sizeLineLess(aSize, bSize, aLine, bLine string) bool {
	if sizeNum(aSize) != sizeNum(bSize) {
		return sizeNum(aSize) < sizeNum(bSize)
	}
	return shortOf(aLine) < shortOf(bLine)
}

type productGroup struct {
	name                 string
	larges, atoms, vials []Piece
}

func byLabel(s []Piece) {
	sort.Slice(s, func(i, j int) bool { return s[i].VariantSize < s[j].VariantSize })
}

// buildProduct turns one product's pieces into offers and missing reasons.
func buildProduct(id string, g *productGroup, p Prices) ProductBundles {
	byLabel(g.atoms)
	byLabel(g.vials)
	pb := ProductBundles{ProductID: id, ProductName: g.name, Offers: []Offer{}, Missing: []Missing{}}
	for _, l := range g.larges {
		price, ok := p.PriceFor(l.Line, l.Size)
		if !ok {
			continue
		}
		if len(g.atoms) == 0 {
			pb.Missing = append(pb.Missing, Missing{l.Line, l.Size, "no_atomizer", missingText("no_atomizer", l.Line)})
			continue
		}
		var vial *Piece
		for i := range g.vials {
			if g.vials[i].Line == l.Line {
				vial = &g.vials[i]
				break
			}
		}
		if vial == nil {
			pb.Missing = append(pb.Missing, Missing{l.Line, l.Size, "no_vial", missingText("no_vial", l.Line)})
			continue
		}
		pb.Offers = append(pb.Offers, Offer{Line: l.Line, Size: l.Size, Price: price,
			LargeSize: l.VariantSize, AtomizerSize: g.atoms[0].VariantSize, VialSize: vial.VariantSize})
	}
	sort.Slice(pb.Offers, func(i, j int) bool {
		return sizeLineLess(pb.Offers[i].Size, pb.Offers[j].Size, pb.Offers[i].Line, pb.Offers[j].Line)
	})
	sort.Slice(pb.Missing, func(i, j int) bool {
		return sizeLineLess(pb.Missing[i].Size, pb.Missing[j].Size, pb.Missing[i].Line, pb.Missing[j].Line)
	})
	return pb
}

// Derive builds the catalog. Products with a large piece are listed by name; offers sort by
// size then line short name ("" first). With several atomizers or vials the first by
// variant label is used.
func Derive(vs []Variant, p Prices) Catalog {
	groups := map[string]*productGroup{}
	lineSet := map[string]bool{}
	var cat Catalog
	for _, v := range vs {
		pc, ok := Classify(v, p)
		if !ok {
			continue
		}
		cat.Pieces = append(cat.Pieces, pc)
		g := groups[v.ProductID]
		if g == nil {
			g = &productGroup{name: v.ProductName}
			groups[v.ProductID] = g
		}
		switch pc.Role {
		case RoleLarge:
			g.larges = append(g.larges, pc)
			if pc.Line != "" {
				lineSet[pc.Line] = true
			}
		case RoleAtomizer:
			g.atoms = append(g.atoms, pc)
		case RoleVial:
			g.vials = append(g.vials, pc)
		}
	}
	for id, g := range groups {
		if len(g.larges) > 0 {
			cat.Products = append(cat.Products, buildProduct(id, g, p))
		}
	}
	sort.Slice(cat.Products, func(i, j int) bool {
		if cat.Products[i].ProductName != cat.Products[j].ProductName {
			return cat.Products[i].ProductName < cat.Products[j].ProductName
		}
		return cat.Products[i].ProductID < cat.Products[j].ProductID
	})
	for l := range lineSet {
		cat.Lines = append(cat.Lines, l)
	}
	sort.Strings(cat.Lines)
	return cat
}
