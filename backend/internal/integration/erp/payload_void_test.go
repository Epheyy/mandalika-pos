package erp

import "testing"

func voidInput(ms ...MovementRow) BuildInput {
	in := input("void", ms...)
	in.Order = saleOrder(150000, OrderTender{"cash", 100000}, OrderTender{"qris", 50000})
	return in
}

func TestBuildVoidDocumentIsRefundOnTheWire(t *testing.T) {
	a, b := movement("a", 1), movement("b", 2)
	a.RefundOfMovementID, b.RefundOfMovementID = "orig-a", "orig-b"
	in := voidInput(a, b)
	in.Order.LinePrice["item-a"] = 70000
	doc := mustBuild(t, in)
	if doc.Kind != "refund" {
		t.Fatalf("kind = %q, want refund", doc.Kind)
	}
	if doc.Ref.Type != "void" || doc.Ref.ID != "ref1" || doc.Ref.Number != "KMG-1" {
		t.Fatalf("ref = %+v, want void/ref1/KMG-1", doc.Ref)
	}
	if doc.OccurredAt != "2026-11-01T20:15:20Z" {
		t.Fatalf("occurred_at = %s, want the movement's", doc.OccurredAt)
	}
	for i, l := range doc.Lines {
		if l.Qty <= 0 {
			t.Errorf("line %d qty = %d, want > 0", i, l.Qty)
		}
		if l.RefundOfMovementID == "" || l.Reason != "refund" {
			t.Errorf("line %d = %+v, want refund_of_movement_id and reason refund", i, l)
		}
	}
	if doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 70000 {
		t.Errorf("unit_price = %v, want the sale line price", doc.Lines[0].UnitPrice)
	}
}

func TestBuildVoidDocumentTendersNegateTheSale(t *testing.T) {
	m := movement("a", 1)
	m.RefundOfMovementID = "orig-a"
	doc := mustBuild(t, voidInput(m))
	want := []Tender{{Method: "cash", Amount: -100000}, {Method: "qris", Amount: -50000}}
	if len(doc.Tenders) != 2 || doc.Tenders[0] != want[0] || doc.Tenders[1] != want[1] {
		t.Fatalf("part 1 tenders = %+v, want %+v", doc.Tenders, want)
	}
	in := voidInput(m)
	in.Header.Part, in.Header.PartCount = 2, 2
	if doc := mustBuild(t, in); len(doc.Tenders) != 0 {
		t.Fatalf("part 2 tenders = %+v, want none", doc.Tenders)
	}
}

func TestWireKindLeavesOtherKindsAlone(t *testing.T) {
	for k := range knownKinds {
		want := k
		if k == "void" {
			want = "refund"
		}
		if got := wireKind(k); got != want {
			t.Errorf("wireKind(%q) = %q, want %q", k, got, want)
		}
	}
	if got := wireRefType("sale", "order"); got != "order" {
		t.Errorf("wireRefType(sale) = %q", got)
	}
}
