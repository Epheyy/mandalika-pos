package ledger

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

var testTime = time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)

func baseDoc(lines ...Line) Document {
	return Document{
		Key: "sale:o1", Kind: KindSale, LocationType: LocOutlet,
		LocationID: "00000000-0000-4000-8000-000000000001", RefType: "order", OccurredAt: testTime, Lines: lines,
	}
}

func line(product, size string, qty int, dedupe string) Line {
	return Line{ProductID: product, VariantSize: size, Qty: qty, DedupeKey: dedupe}
}

func TestDocumentIDIsDeterministicAndPartsDiffer(t *testing.T) {
	if DocumentID("sale:o1", 0) != DocumentID("sale:o1", 0) {
		t.Fatal("same key must give the same id")
	}
	ids := map[string]bool{}
	for _, id := range []string{
		DocumentID("sale:o1", 0), DocumentID("sale:o1", 1), DocumentID("sale:o1", 2), DocumentID("sale:o2", 0),
	} {
		if ids[id] {
			t.Fatalf("duplicate id %s", id)
		}
		ids[id] = true
	}
	// Frozen: a change here means the namespace or derivation moved and every
	// already-written (or ERP-sent) id would no longer match.
	if got, want := DocumentID("sale:o1", 0), "9d38fc4d-8b0a-523a-9089-73e81b701343"; got != want {
		t.Fatalf("DocumentID(sale:o1,0) = %s, want %s", got, want)
	}
	if got, want := MovementID("sale:i1"), "2b5f2b21-d97f-52fd-9162-5b4e1eac646d"; got != want {
		t.Fatalf("MovementID(sale:i1) = %s, want %s", got, want)
	}
}

func TestMovementIDIsDeterministicAndSeparateFromDocumentID(t *testing.T) {
	if MovementID("sale:i1") != MovementID("sale:i1") {
		t.Fatal("same dedupe key must give the same id")
	}
	if MovementID("sale:i1") == MovementID("sale:i2") {
		t.Fatal("different dedupe keys must differ")
	}
	if MovementID("sale:o1") == DocumentID("sale:o1", 0) {
		t.Fatal("movement and document ids must not collide for the same string")
	}
}

func TestPrepareValidationAndZeroFilter(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Document)
		wantErr string
		want    int
	}{
		{"ok keeps non-zero lines", func(d *Document) {}, "", 2},
		{"empty key", func(d *Document) { d.Key = "" }, "needs key", 0},
		{"empty location", func(d *Document) { d.LocationID = "" }, "needs key", 0},
		{"empty ref type", func(d *Document) { d.RefType = "" }, "needs key", 0},
		{"bad kind", func(d *Document) { d.Kind = "bogus" }, "unknown kind", 0},
		{"bad location type", func(d *Document) { d.LocationType = "shop" }, "unknown location type", 0},
		{"zero occurred_at", func(d *Document) { d.OccurredAt = time.Time{} }, "occurred_at", 0},
		{"missing dedupe key", func(d *Document) { d.Lines[0].DedupeKey = "" }, "dedupe key and product id", 0},
		{"missing product", func(d *Document) { d.Lines[0].ProductID = "" }, "dedupe key and product id", 0},
		{"duplicate dedupe key", func(d *Document) { d.Lines[1].DedupeKey = d.Lines[0].DedupeKey }, "duplicate dedupe key", 0},
		{"zero-qty line dropped", func(d *Document) { d.Lines = append(d.Lines, line("p3", "50ml", 0, "z")) }, "", 2},
		{"all zero gives empty", func(d *Document) { d.Lines = []Line{line("p3", "50ml", 0, "z")} }, "", 0},
		{"opening keeps zero-qty", func(d *Document) {
			d.Kind = KindOpening
			d.Lines = []Line{line("p3", "50ml", 0, "z")}
		}, "", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := baseDoc(line("p1", "50ml", -1, "a"), line("p2", "50ml", 2, "b"))
			c.mutate(&d)
			got, err := prepare(d)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, c.wantErr)
				}
				return
			}
			if err != nil || len(got) != c.want {
				t.Fatalf("lines=%d err=%v, want %d", len(got), err, c.want)
			}
		})
	}
}

func manyLines(n int) []Line {
	out := make([]Line, n)
	for i := range out {
		// Zero-padded so lexical order == numeric order, in reverse input order.
		id := fmt.Sprintf("p%04d", n-i)
		out[i] = line(id, "50ml", 1, "k:"+id)
	}
	return out
}

func TestSplitPartsSortsAndChunks(t *testing.T) {
	cases := []struct {
		name  string
		n     int
		sizes []int
	}{
		{"empty", 0, nil},
		{"one", 1, []int{1}},
		{"exactly 200 is one part", 200, []int{200}},
		{"201 splits", 201, []int{200, 1}},
		{"450 gives 3 parts", 450, []int{200, 200, 50}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			chunks := splitParts(manyLines(c.n))
			if len(chunks) != len(c.sizes) {
				t.Fatalf("chunks = %d, want %d", len(chunks), len(c.sizes))
			}
			prev := ""
			for i, ch := range chunks {
				if len(ch) != c.sizes[i] {
					t.Errorf("chunk %d has %d lines, want %d", i, len(ch), c.sizes[i])
				}
				for _, l := range ch {
					if l.ProductID <= prev {
						t.Fatalf("not sorted: %s after %s", l.ProductID, prev)
					}
					prev = l.ProductID
				}
			}
		})
	}
}

func TestSplitPartsIsStableAcrossInputOrder(t *testing.T) {
	fwd := manyLines(450)
	rev := make([]Line, len(fwd))
	for i, l := range fwd {
		rev[len(fwd)-1-i] = l
	}
	a, b := splitParts(fwd), splitParts(rev)
	for i := range a {
		for j := range a[i] {
			if a[i][j].DedupeKey != b[i][j].DedupeKey {
				t.Fatalf("part %d line %d differs between input orders", i, j)
			}
		}
	}
}

func TestSplitPartsKeepsCallerOrderWithinAKey(t *testing.T) {
	// Application order is "z" then "a" (reverse of lexical); a stable sort by
	// (product, size) must keep it so the per-key chain stays in order.
	in := []Line{line("p2", "s", -1, "x"), line("p1", "s", -3, "z-first"), line("p1", "s", -2, "a-second")}
	got := splitParts(in)
	if len(got) != 1 || got[0][0].DedupeKey != "z-first" || got[0][1].DedupeKey != "a-second" || got[0][2].DedupeKey != "x" {
		t.Fatalf("order = %+v", got)
	}
}

func TestSplitPartDocumentIDs(t *testing.T) {
	// 450 lines -> parts 1..3 with DocumentID(key, 1..3); 200 -> single part 0.
	for _, c := range []struct {
		n     int
		parts []int
	}{{450, []int{1, 2, 3}}, {200, []int{0}}} {
		chunks := splitParts(manyLines(c.n))
		if len(chunks) != len(c.parts) {
			t.Fatalf("n=%d: %d chunks", c.n, len(chunks))
		}
		for i, want := range c.parts {
			part := 0
			if len(chunks) > 1 {
				part = i + 1
			}
			if part != want {
				t.Errorf("n=%d chunk %d: part %d, want %d", c.n, i, part, want)
			}
		}
	}
	if DocumentID("count:c1", 0) == DocumentID("count:c1", 1) {
		t.Fatal("part 1 must differ from the unsplit id")
	}
}

func TestFillBeforeAfterWalksBackwardsPerKey(t *testing.T) {
	cases := []struct {
		name    string
		lines   []Line
		current map[lineKey]int
		before  []int
		after   []int
	}{
		{"single decrement", []Line{line("p", "s", -3, "a")}, map[lineKey]int{{"p", "s"}: 7}, []int{10}, []int{7}},
		{"two lines same key",
			[]Line{line("p", "s", -3, "a"), line("p", "s", -2, "b")},
			map[lineKey]int{{"p", "s"}: 5}, []int{10, 7}, []int{7, 5}},
		{"interleaved keys",
			[]Line{line("p", "s", -1, "a"), line("q", "s", 4, "b"), line("p", "s", 2, "c")},
			map[lineKey]int{{"p", "s"}: 6, {"q", "s"}: 9}, []int{5, 5, 4}, []int{4, 9, 6}},
		{"negative stock (shortage)", []Line{line("p", "s", -5, "a")}, map[lineKey]int{{"p", "s"}: -2}, []int{3}, []int{-2}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			orig := append([]Line(nil), c.lines...)
			got := fillBeforeAfter(c.lines, c.current)
			for i, l := range got {
				if l.QtyBefore != c.before[i] || l.QtyAfter != c.after[i] {
					t.Errorf("line %d: before/after %d/%d, want %d/%d", i, l.QtyBefore, l.QtyAfter, c.before[i], c.after[i])
				}
				if l.QtyAfter != l.QtyBefore+l.Qty {
					t.Errorf("line %d breaks after = before + qty", i)
				}
				if l.DedupeKey != c.lines[i].DedupeKey {
					t.Errorf("line %d reordered", i)
				}
			}
			for i := range orig {
				if c.lines[i].QtyBefore != 0 || c.lines[i].QtyAfter != 0 {
					t.Errorf("input line %d was mutated", i)
				}
			}
		})
	}
}

func TestNullableMapsEmptyToNil(t *testing.T) {
	if nullable("") != nil || nullable("x") != "x" {
		t.Fatal("nullable must map only the empty string to nil")
	}
}

func TestBackfillLineModes(t *testing.T) {
	opening := BackfillOptions{}
	reanchor := BackfillOptions{Reanchor: true, RunID: "r1"}
	cases := []struct {
		name   string
		k      stockKeyRow
		opts   BackfillOptions
		wantOK bool
		qty    int
		dedupe string
	}{
		{"opening on fresh key", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", hasLive: true, live: 9}, opening, true, 9, "opening:outlet:L:P:s"},
		{"opening qty is live minus ledger", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", hasLive: true, live: 9, ledger: 4}, opening, true, 5, "opening:outlet:L:P:s"},
		{"opening skipped when already opened", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", hasLive: true, live: 9, ledger: 9, hasOpening: true}, opening, false, 0, ""},
		{"opening skipped for ledger-only key", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", ledger: 3}, opening, false, 0, ""},
		{"opening keeps zero-stock key", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", hasLive: true}, opening, true, 0, "opening:outlet:L:P:s"},
		{"reanchor drift", stockKeyRow{lt: "warehouse", lid: "L", pid: "P", size: "s", hasLive: true, live: 2, ledger: 5, hasOpening: true}, reanchor, true, -3, "reanchor:r1:warehouse:L:P:s"},
		{"reanchor no drift", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", hasLive: true, live: 5, ledger: 5}, reanchor, false, 0, ""},
		{"reanchor ledger-only key", stockKeyRow{lt: "outlet", lid: "L", pid: "P", size: "s", ledger: 4}, reanchor, true, -4, "reanchor:r1:outlet:L:P:s"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l, ok := backfillLine(c.k, c.opts)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if ok && (l.Qty != c.qty || l.DedupeKey != c.dedupe || l.QtyAfter != l.QtyBefore+l.Qty) {
				t.Fatalf("line = %+v, want qty %d dedupe %s", l, c.qty, c.dedupe)
			}
		})
	}
}

func TestBackfillDocumentsGroupPerLocation(t *testing.T) {
	keys := []stockKeyRow{
		{lt: "outlet", lid: "A", pid: "P1", size: "s", hasLive: true, live: 1},
		{lt: "outlet", lid: "A", pid: "P2", size: "s", hasLive: true, live: 2},
		{lt: "warehouse", lid: "W", pid: "P1", size: "s", hasLive: true, live: 3},
	}
	docs := backfillDocuments(keys, BackfillOptions{RunID: "r0", OccurredAt: testTime})
	if len(docs) != 2 || len(docs[0].Lines) != 2 || len(docs[1].Lines) != 1 {
		t.Fatalf("docs = %+v", docs)
	}
	if docs[0].Key != "opening:r0:outlet:A" || docs[0].Kind != KindOpening || docs[0].RefType != "backfill" {
		t.Fatalf("doc 0 = %+v", docs[0])
	}
	keys[0].ledger, keys[1].ledger, keys[2].ledger = 1, 2, 0
	re := backfillDocuments(keys, BackfillOptions{Reanchor: true, RunID: "r9", OccurredAt: testTime})
	if len(re) != 1 || re[0].Key != "reanchor:r9:warehouse:W" || re[0].Kind != KindAdjust {
		t.Fatalf("only the drifted warehouse key may be reanchored, got %+v", re)
	}
}

func TestCanonicalizeNormalisesUUIDSpellings(t *testing.T) {
	const canon = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	for name, in := range map[string]string{
		"upper":     strings.ToUpper(canon),
		"no-hyphen": strings.ReplaceAll(canon, "-", ""),
		"braced":    "{" + canon + "}",
	} {
		d := baseDoc(Line{ProductID: in, VariantSize: "s", Qty: 1, DedupeKey: "k", VariantID: in, RefundOfMovementID: in})
		d.LocationID, d.RefID = in, in
		got, err := canonicalize(d)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		l := got.Lines[0]
		if got.LocationID != canon || got.RefID != canon || l.ProductID != canon || l.VariantID != canon || l.RefundOfMovementID != canon || l.DedupeKey != "k" {
			t.Fatalf("%s: not canonical: %+v %+v", name, got, l)
		}
		if d.Lines[0].ProductID != in {
			t.Fatalf("%s: the caller's lines were mutated", name)
		}
	}
	bad := baseDoc(Line{ProductID: "not-a-uuid", VariantSize: "s", Qty: 1, DedupeKey: "k"})
	if _, err := canonicalize(bad); err == nil {
		t.Fatal("a garbage product id must be a validation error")
	}
	empty, err := canonicalize(baseDoc(Line{ProductID: canon, VariantSize: "s", Qty: 1, DedupeKey: "k"}))
	if err != nil || empty.RefID != "" || empty.Lines[0].VariantID != "" {
		t.Fatalf("empty optional ids must stay empty: %+v %v", empty, err)
	}
}

func TestMixedCaseDuplicatesChainAfterCanonicalize(t *testing.T) {
	const canon = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	d, err := canonicalize(baseDoc(
		Line{ProductID: strings.ToUpper(canon), VariantSize: "s", Qty: -3, DedupeKey: "a"},
		Line{ProductID: canon, VariantSize: "s", Qty: -2, DedupeKey: "b"}))
	if err != nil {
		t.Fatal(err)
	}
	out := fillBeforeAfter(d.Lines, map[lineKey]int{{canon, "s"}: 5})
	if out[0].QtyBefore != 10 || out[0].QtyAfter != 7 || out[1].QtyBefore != 7 || out[1].QtyAfter != 5 {
		t.Fatalf("spellings of one product must chain as one key: %+v", out)
	}
}

func TestValidKindsIncludesVoid(t *testing.T) {
	if !validKinds[KindVoid] || KindVoid != "void" {
		t.Fatal("void must be a valid ledger kind")
	}
	b, err := BucketOf(BucketInput{Kind: KindVoid})
	if err != nil || b != BucketRefund {
		t.Fatalf("void bucket = %q, %v; want the refund (returns) bucket", b, err)
	}
}
