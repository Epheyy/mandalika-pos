package service

import "testing"

// bundleCfg is the canonical 3-slot perfume bundle used across these tests:
// one 110ml, one atomizer (either atomA or atomB), one 2ml — priced as a set.
func bundleCfg(bundlePrice float64) *BundleConfig {
	return &BundleConfig{
		Slots: []BundleSlot{
			{ProductKeys: []string{"p110"}, Quantity: 1},
			{ProductKeys: []string{"atomA", "atomB"}, Quantity: 1},
			{ProductKeys: []string{"p2ml"}, Quantity: 1},
		},
		BundlePrice: bundlePrice,
	}
}

func paidLine(id string, price float64, qty int) LineItem {
	return LineItem{ProductID: id, Price: price, Quantity: qty}
}

func freedUnit(id string, full float64) bundleFreedUnit {
	return bundleFreedUnit{ProductID: id, FullPrice: full}
}

// 1. Owner's clean combo: 110ml paid (575000) + atomizer freed (225000) + 2ml freed
// (1), bundlePrice 575000 → both freed units drop to 0.
func TestBundleFreedNets_CleanCombo(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1)}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000), freedUnit("p2ml", 1)}

	nets, ok := bundleFreedNets(bundleCfg(575000), paid, freed)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if len(nets) != 2 || nets[0] != 0 || nets[1] != 0 {
		t.Fatalf("nets = %v, want [0 0]", nets)
	}
}

// 2a. Partial: a smaller discount (bundlePrice 700000, D=100001) zeroes the cheapest
// freed unit (2ml) fully and only partially discounts the more expensive freed unit
// (atomizer → 225000-100000 = 125000).
//
// NOTE (brief deviation): the brief lists this case at bundlePrice 500000, but with a
// 575000 anchor a 500000 bundle price forces the discount onto the ANCHOR (see
// TestBundleFreedNets_AnchorAbsorbsOverflow below) and leaves both freed units at 0 —
// it cannot produce a partial FREED unit. 700000 is the smallest clean value that
// exercises the "partial net on a freed unit" path the brief intends.
func TestBundleFreedNets_PartialFreedUnit(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1)}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000), freedUnit("p2ml", 1)}

	nets, ok := bundleFreedNets(bundleCfg(700000), paid, freed)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	// D = (575000+225000+1) - 700000 = 100001. Cheapest-first: 2ml(1)->0 (spends 1),
	// remaining 100000 comes off the atomizer: 225000-100000 = 125000. Anchor untouched.
	if nets[0] != 125000 || nets[1] != 0 {
		t.Fatalf("nets = %v, want [125000 0]", nets)
	}
}

// 2b. At bundlePrice 500000 the discount overflows the freed units onto the paid
// anchor; the helper only reprices freed lines, so both freed units are 0 and the
// anchor overflow is silently absorbed (server-authoritative, never overcharges below
// full anchor). Documents the exact behavior for the brief's 500000 number.
func TestBundleFreedNets_AnchorAbsorbsOverflow(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1)}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000), freedUnit("p2ml", 1)}

	nets, ok := bundleFreedNets(bundleCfg(500000), paid, freed)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if nets[0] != 0 || nets[1] != 0 {
		t.Fatalf("nets = %v, want [0 0] (overflow absorbed by anchor)", nets)
	}
}

// 3. Tamper: a freed unit not eligible for any slot → ok=false.
func TestBundleFreedNets_FreedNotSlotEligible(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1), paidLine("p2ml", 1, 1)}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000), freedUnit("wrongProduct", 50000)}

	if _, ok := bundleFreedNets(bundleCfg(575000), paid, freed); ok {
		t.Fatalf("expected ok=false for ineligible freed unit")
	}
}

// 4. Tamper: no complete set (the 2ml slot is unrepresented among owned units) → ok=false.
func TestBundleFreedNets_NoCompleteSet(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1)}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000)} // no 2ml anywhere

	if _, ok := bundleFreedNets(bundleCfg(575000), paid, freed); ok {
		t.Fatalf("expected ok=false when a slot has no owned unit")
	}
}

// 5. Tamper (the exploit): the client frees the EXPENSIVE atomizer (atomB 300000)
// while leaving the cheaper eligible atomizer (atomA 225000) paid. Freeing the
// expensive one would save 300000 instead of 225000 → must be rejected.
func TestBundleFreedNets_FreeExpensiveAnchorRejected(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1), paidLine("atomA", 225000, 1)}
	freed := []bundleFreedUnit{freedUnit("atomB", 300000), freedUnit("p2ml", 1)}

	if _, ok := bundleFreedNets(bundleCfg(575000), paid, freed); ok {
		t.Fatalf("expected ok=false: cheaper eligible unit left paid while pricier one freed")
	}
}

// 6. Two-atomizer picker: owned has atomA(225000, freed) + atomB(300000, paid) plus
// 110ml + 2ml. The chosen (cheaper) atomA is freed; atomB is an EXTRA unit outside the
// bundle and stays untouched. Freed nets [0,0], ok=true.
func TestBundleFreedNets_TwoAtomizersChoosesCheapest(t *testing.T) {
	paid := []LineItem{
		paidLine("p110", 575000, 1),
		paidLine("atomB", 300000, 1), // extra atomizer, not consumed
	}
	freed := []bundleFreedUnit{freedUnit("atomA", 225000), freedUnit("p2ml", 1)}

	nets, ok := bundleFreedNets(bundleCfg(575000), paid, freed)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if nets[0] != 0 || nets[1] != 0 {
		t.Fatalf("nets = %v, want [0 0]", nets)
	}
}

// Guard: nil config or no freed units → ok=false (nothing to resolve).
func TestBundleFreedNets_Guards(t *testing.T) {
	if _, ok := bundleFreedNets(nil, nil, []bundleFreedUnit{freedUnit("atomA", 1)}); ok {
		t.Fatalf("nil cfg: expected ok=false")
	}
	if _, ok := bundleFreedNets(bundleCfg(575000), []LineItem{paidLine("p110", 575000, 1)}, nil); ok {
		t.Fatalf("no freed units: expected ok=false")
	}
}

// Over-free: two 2ml units freed but the set only consumes one per application → the
// slot is over-freed → ok=false.
func TestBundleFreedNets_OverFreedSlotRejected(t *testing.T) {
	paid := []LineItem{paidLine("p110", 575000, 1), paidLine("atomA", 225000, 1)}
	// two 2ml freed but nApp=1 (one 110ml, one atomizer) → 2ml slot needs only 1.
	freed := []bundleFreedUnit{freedUnit("p2ml", 1), freedUnit("p2ml", 1)}

	if _, ok := bundleFreedNets(bundleCfg(575000), paid, freed); ok {
		t.Fatalf("expected ok=false when a slot is over-freed")
	}
}
